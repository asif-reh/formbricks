import "server-only";

import { prisma } from "@formbricks/database";
import { ZOptionalNumber, ZString } from "@formbricks/types/common";
import { ZId } from "@formbricks/types/environment";
import { DatabaseError } from "@formbricks/types/errors";
import { TPerson, TPersonUpdateInput, ZPersonUpdateInput } from "@formbricks/types/people";
import { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { ITEMS_PER_PAGE, SERVICES_REVALIDATION_INTERVAL } from "../constants";
import { validateInputs } from "../utils/validate";
import { personCache } from "./cache";
import { createAttributeClass, getAttributeClassByName } from "../attributeClass/service";

export const selectPerson = {
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
  environmentId: true,
  attributes: {
    where: {
      attributeClass: {
        archived: false,
      },
    },
    select: {
      value: true,
      attributeClass: {
        select: {
          name: true,
          id: true,
        },
      },
    },
  },
};

type TransformPersonInput = {
  id: string;
  userId: string;
  environmentId: string;
  attributes: {
    value: string;
    attributeClass: {
      name: string;
    };
  }[];
  createdAt: Date;
  updatedAt: Date;
};

export const transformPrismaPerson = (person: TransformPersonInput): TPerson => {
  const attributes = person.attributes.reduce((acc, attr) => {
    acc[attr.attributeClass.name] = attr.value;
    return acc;
  }, {} as Record<string, string | number>);

  return {
    id: person.id,
    userId: person.userId,
    attributes: attributes,
    environmentId: person.environmentId,
    createdAt: new Date(person.createdAt),
    updatedAt: new Date(person.updatedAt),
  } as TPerson;
};

export const getPerson = async (personId: string): Promise<TPerson | null> => {
  const prismaPerson = await unstable_cache(
    async () => {
      validateInputs([personId, ZId]);

      try {
        return await prisma.person.findUnique({
          where: {
            id: personId,
          },
          select: selectPerson,
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          throw new DatabaseError(error.message);
        }

        throw error;
      }
    },
    [`getPerson-${personId}`],
    { tags: [personCache.tag.byId(personId)], revalidate: SERVICES_REVALIDATION_INTERVAL }
  )();

  if (!prismaPerson) {
    return null;
  }

  return transformPrismaPerson(prismaPerson);
};

export const getPeople = async (environmentId: string, page?: number): Promise<TPerson[]> => {
  const peoplePrisma = await unstable_cache(
    async () => {
      validateInputs([environmentId, ZId], [page, ZOptionalNumber]);

      try {
        return await prisma.person.findMany({
          where: {
            environmentId: environmentId,
          },
          select: selectPerson,
          take: page ? ITEMS_PER_PAGE : undefined,
          skip: page ? ITEMS_PER_PAGE * (page - 1) : undefined,
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          throw new DatabaseError(error.message);
        }

        throw error;
      }
    },
    [`getPeople-${environmentId}-${page}`],
    {
      tags: [personCache.tag.byEnvironmentId(environmentId)],
      revalidate: SERVICES_REVALIDATION_INTERVAL,
    }
  )();

  if (!peoplePrisma || peoplePrisma.length === 0) {
    return [];
  }

  return peoplePrisma
    .map(transformPrismaPerson)
    .filter((person: TPerson | null): person is TPerson => person !== null);
};

export const getPeopleCount = async (environmentId: string): Promise<number> =>
  unstable_cache(
    async () => {
      validateInputs([environmentId, ZId]);

      try {
        return await prisma.person.count({
          where: {
            environmentId: environmentId,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          throw new DatabaseError(error.message);
        }

        throw error;
      }
    },
    [`getPeopleCount-${environmentId}`],
    {
      tags: [personCache.tag.byEnvironmentId(environmentId)],
      revalidate: SERVICES_REVALIDATION_INTERVAL,
    }
  )();

export const createPerson = async (environmentId: string, userId: string): Promise<TPerson> => {
  validateInputs([environmentId, ZId]);

  try {
    const person = await prisma.person.create({
      data: {
        environment: {
          connect: {
            id: environmentId,
          },
        },
        userId,
      },
      select: selectPerson,
    });

    const transformedPerson = transformPrismaPerson(person);

    personCache.revalidate({
      id: transformedPerson.id,
      environmentId,
      userId,
    });

    return transformedPerson;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new DatabaseError(error.message);
    }

    throw error;
  }
};

export const deletePerson = async (personId: string): Promise<TPerson | null> => {
  validateInputs([personId, ZId]);

  try {
    const person = await prisma.person.delete({
      where: {
        id: personId,
      },
      select: selectPerson,
    });
    const transformedPerson = transformPrismaPerson(person);

    personCache.revalidate({
      id: transformedPerson.id,
      environmentId: transformedPerson.environmentId,
    });

    return transformedPerson;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new DatabaseError(error.message);
    }

    throw error;
  }
};

export const updatePerson = async (personId: string, personInput: TPersonUpdateInput): Promise<TPerson> => {
  validateInputs([personId, ZId], [personInput, ZPersonUpdateInput]);

  try {
    const person = await getPerson(personId);
    if (!person) {
      throw new Error(`Person ${personId} not found`);
    }

    // Process each attribute
    const attributeUpdates = Object.entries(personInput.attributes).map(async ([attributeName, value]) => {
      let attributeClass = await getAttributeClassByName(person.environmentId, attributeName);

      // Create new attribute class if not found
      if (attributeClass === null) {
        attributeClass = await createAttributeClass(person.environmentId, attributeName, "code");
      }

      // Now perform the upsert for the attribute with the found or created attributeClassId
      await prisma.attribute.upsert({
        where: {
          attributeClassId_personId: {
            attributeClassId: attributeClass!.id,
            personId,
          },
        },
        update: {
          value: value.toString(),
        },
        create: {
          attributeClass: {
            connect: {
              id: attributeClass!.id,
            },
          },
          person: {
            connect: {
              id: personId,
            },
          },
          value: value.toString(),
        },
      });
    });

    // Execute all attribute updates
    await Promise.all(attributeUpdates);

    personCache.revalidate({
      id: personId,
      environmentId: person.environmentId,
    });

    const updatedPerson = await getPerson(personId);

    if (!updatedPerson) {
      throw new Error(`Person ${personId} not found`);
    }

    return updatedPerson;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new DatabaseError(error.message);
    }

    throw error;
  }
};

export const getPersonByUserId = async (environmentId: string, userId: string): Promise<TPerson | null> => {
  const personPrisma = await unstable_cache(
    async () => {
      validateInputs([userId, ZString], [environmentId, ZId]);

      // check if userId exists as a column
      const personWithUserId = await prisma.person.findFirst({
        where: {
          environmentId,
          userId,
        },
        select: selectPerson,
      });

      if (personWithUserId) {
        return personWithUserId;
      }

      // Check if a person with the userId attribute exists
      let personWithUserIdAttribute = await prisma.person.findFirst({
        where: {
          environmentId,
          attributes: {
            some: {
              attributeClass: {
                name: "userId",
              },
              value: userId,
            },
          },
        },
        select: selectPerson,
      });

      const userIdAttributeClassId = personWithUserIdAttribute?.attributes.find(
        (attr) => attr.attributeClass.name === "userId" && attr.value === userId
      )?.attributeClass.id;

      if (!personWithUserIdAttribute) {
        return null;
      }

      personWithUserIdAttribute = await prisma.person.update({
        where: {
          id: personWithUserIdAttribute.id,
        },
        data: {
          userId,
          attributes: {
            deleteMany: { attributeClassId: userIdAttributeClassId },
          },
        },
        select: selectPerson,
      });

      personCache.revalidate({
        id: personWithUserIdAttribute.id,
        environmentId,
        userId,
      });

      return personWithUserIdAttribute;
    },
    [`getPersonByUserId-${userId}-${environmentId}`],
    {
      tags: [
        personCache.tag.byEnvironmentIdAndUserId(environmentId, userId),
        personCache.tag.byUserId(userId), // fix for caching issue on vercel
        personCache.tag.byEnvironmentId(environmentId), // fix for caching issue on vercel
      ],
      revalidate: SERVICES_REVALIDATION_INTERVAL,
    }
  )();
  if (!personPrisma) {
    return null;
  }
  return transformPrismaPerson(personPrisma);
};

export const updatePersonAttribute = async (
  personId: string,
  attributeClassId: string,
  value: string
): Promise<Partial<TPerson>> => {
  validateInputs([personId, ZId], [attributeClassId, ZId], [value, ZString]);

  const attributes = await prisma.attribute.upsert({
    where: {
      attributeClassId_personId: {
        attributeClassId,
        personId,
      },
    },
    update: {
      value,
    },
    create: {
      attributeClass: {
        connect: {
          id: attributeClassId,
        },
      },
      person: {
        connect: {
          id: personId,
        },
      },
      value,
    },
  });

  personCache.revalidate({
    id: personId,
  });

  return attributes;
};
