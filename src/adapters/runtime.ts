import type { AuditSink } from '../safety/guard.js';
import { MaxSourceAdapter } from './max-source.js';
import { OverloopExecutionAdapter } from './overloop-execution.js';
import type { ExecutionAdapter } from './execution.js';
import type { ManagedSourceAdapter, SourceAdapter } from './source.js';
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
