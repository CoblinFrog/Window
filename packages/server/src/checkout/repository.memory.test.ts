/**
 * In-memory repository tests for the checkout repository.
 *
 * This file runs the conformance test suite against the in-memory implementation.
 */

import { describeCheckoutRepositorySimple } from './repository.conformance.simple.js';
import { MemoryCheckoutRepository } from './repository.memory.js';

describeCheckoutRepositorySimple('memory', async () => {
  const repo = new MemoryCheckoutRepository();
  await repo.truncate();
  return repo;
});
