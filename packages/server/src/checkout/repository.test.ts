import { describeCheckoutRepository } from './repository.conformance.js';
import { MemoryCheckoutRepository } from './repository.memory.js';

/**
 * The in-memory store against the shared contract.
 *
 * When the Supabase implementation lands it gets a file exactly like this one,
 * and the same cases run against it. That is the whole point: the contract is
 * written once, and "is the new store correct?" stops being a judgement call.
 */
describeCheckoutRepository('memory', async () => new MemoryCheckoutRepository());
