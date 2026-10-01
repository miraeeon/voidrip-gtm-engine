import type { AuditSink } from '../safety/guard.js';
import { MaxSourceAdapter } from './max-source.js';
import { HeyReachAdapter } from './heyreach-execution.js';
import { OverloopExecutionAdapter } from './overloop-execution.js';
import type { ExecutionAdapter } from './execution.js';
import type { ManagedSourceAdapter, SourceAdapter } from './source.js';
import { HeyReachClient } from '../clients/heyreach.js';
import { OverloopClient } from '../clients/overloop.js';

export function createDefaultSourceAdapter(): SourceAdapter {
  return new MaxSourceAdapter();
}

export function createDefaultManagedSourceAdapter(): ManagedSourceAdapter {
  return new MaxSourceAdapter();
}

export function createDefaultExecutionAdapter(audit?: AuditSink): ExecutionAdapter {
  return new OverloopExecutionAdapter(new OverloopClient({ audit }));
}

export function createDefaultHeyReachAdapter(audit?: AuditSink): HeyReachAdapter {
  return new HeyReachAdapter(new HeyReachClient({ audit }));
}
