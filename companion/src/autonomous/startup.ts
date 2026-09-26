/** Autonomous mode owns its named worker bodies; other brains retain the generic body. */
export const shouldSpawnGenericCompanion = (brainKind: string): boolean => brainKind !== "autonomous";
