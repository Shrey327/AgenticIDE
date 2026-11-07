import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import {
  FrontendLanguageModelRegistry,
  LanguageModel,
} from '@theia/ai-core/lib/common/language-model';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { WorkspaceTrustService } from '@theia/workspace/lib/browser/workspace-trust-service';
import { EngineeringService, Connection } from '../common/protocol.js';

/** Makes the workspace's keychain-backed connections available to Theia AI. */
@injectable()
export class ModelBridge implements FrontendApplicationContribution {
  @inject(EngineeringService) protected readonly service!: EngineeringService;
  @inject(FrontendLanguageModelRegistry)
  protected readonly registry!: FrontendLanguageModelRegistry;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(WorkspaceTrustService)
  protected readonly trust!: WorkspaceTrustService;
  private timer?: ReturnType<typeof setInterval>;
  private ids: string[] = [];
  onStart() {
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {});
    }, 10000);
  }
  onStop() {
    clearInterval(this.timer);
    this.registry.removeLanguageModels(this.ids);
  }
  async refresh() {
    if (!(await this.trust.getWorkspaceTrust())) return;
    const root = (await this.workspace.roots)[0]?.resource.path.fsPath();
    if (!root) return;
    const connections: Connection[] = await this.service.request({
      workspace: root,
      operation: 'connections.list',
    });
    const models: LanguageModel[] = connections
      .filter((c) => c.kind === 'model' && c.model)
      .map((c) => ({
        id: `aiide/${c.id}`,
        name: `Workspace / ${c.model}`,
        vendor: 'aiide',
        status: { status: 'ready' },
        request: async (request, cancellationToken) => {
          if (cancellationToken?.isCancellationRequested)
            throw new Error('Cancelled');
          if (
            request.tools?.length ||
            request.messages.some((m) => m.type !== 'text')
          )
            throw new Error(
              'Use the AI Engineering assistant for container-scoped tool calls; this Theia provider supports text requests',
            );
          const result = await this.service.request({
            workspace: root,
            operation: 'models.complete',
            args: {
              id: c.id,
              messages: request.messages.map((m) => ({
                role: m.actor === 'ai' ? 'assistant' : m.actor,
                content: m.type === 'text' ? m.text : '',
              })),
            },
          });
          return { text: result.text };
        },
      }));
    this.registry.removeLanguageModels(this.ids);
    this.registry.addLanguageModels(models);
    this.ids = models.map((m) => m.id);
  }
}
