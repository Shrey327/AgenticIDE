export type RunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export interface Run {
  id: string;
  project: string;
  name: string;
  status: RunStatus;
  started: number;
  ended?: number;
  command: string[];
  environment: Record<string, unknown>;
  source: string;
  configuration: Record<string, unknown>;
  training?: {
    target: 'local' | 'ssh';
    framework: 'pytorch' | 'transformers' | 'sklearn' | 'custom';
    parameters: Record<string, unknown>;
    modelPath?: string;
    datasetPath?: string;
    profile?: import('./ssh').SshProfile;
    cursor: number;
    connection: 'connected' | 'disconnected' | 'launching';
    remoteStatus?: string;
    lastSync?: number;
    error?: string;
    dropped?: number;
    resumeFrom?: { runId: string; path: string };
  };
}
export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  runId: string;
  name: string;
  start: number;
  end: number;
  status: string;
  attributes: Record<string, unknown>;
  events: unknown[];
}
export interface EventRecord {
  id?: number;
  runId: string;
  kind: string;
  timestamp: number;
  name: string;
  value: unknown;
  step?: number;
}
export interface Connection {
  id: string;
  kind: 'model' | 'qdrant' | 'prometheus' | 'grafana' | 'wandb' | 'otlp';
  url: string;
  model?: string;
  credentialRef?: string;
  capabilities?: Record<string, boolean>;
  inputPrice?: number;
  outputPrice?: number;
}
export interface Status {
  workspace: string;
  telemetry: string;
  collector: string;
  dropped: number;
  storageBytes: number;
  mcp?: string;
}
export interface RpcRequest {
  workspace: string;
  operation: string;
  args?: Record<string, any>;
}
export interface EngineeringService {
  request(request: RpcRequest): Promise<any>;
}
export const EngineeringService = Symbol('EngineeringService');
export const servicePath = '/services/ai-engineering';
