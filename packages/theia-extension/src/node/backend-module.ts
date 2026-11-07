import { ContainerModule } from '@theia/core/shared/inversify';
import {
  ConnectionHandler,
  RpcConnectionHandler,
} from '@theia/core/lib/common/messaging';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { EngineeringBackend, bundledResources } from '@aiide/core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EngineeringService, servicePath } from '../common/protocol.js';

const plugins = path.join(bundledResources, 'plugins');
process.env.THEIA_CONFIG_DIR ||= path.join(os.homedir(), '.config', 'aiide');
if (fs.existsSync(plugins) && !process.env.THEIA_DEFAULT_PLUGINS)
  process.env.THEIA_DEFAULT_PLUGINS = `local-dir:${plugins}`;

export default new ContainerModule((bind) => {
  const backend = new EngineeringBackend();
  bind(EngineeringService).toConstantValue(backend);
  bind(ConnectionHandler)
    .toDynamicValue(() => new RpcConnectionHandler(servicePath, () => backend))
    .inSingletonScope();
  bind(BackendApplicationContribution).toConstantValue({
    onStop: () => {
      void backend.close();
    },
  });
});
