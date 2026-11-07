import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash, within } from './security';

const execute = promisify(execFile);
const packages: Record<string, string[]> = {
  langchain: ['langchain==1.2.0', 'langchain-openai==1.1.0'],
  langgraph: ['langgraph==1.0.5', 'langchain-openai==1.1.0'],
  qdrant: ['qdrant-client==1.16.1'],
  sklearn: ['scikit-learn==1.7.2'],
  pytorch: ['torch==2.9.1'],
  finetune: ['transformers==4.57.3', 'peft==0.18.0', 'accelerate==1.12.0'],
  wandb: ['wandb==0.23.0'],
};
export class Integrations {
  private plans = new Map<
    string,
    {
      files: { file: string; before: string | null; after: string }[];
      directory: string;
    }
  >();
  constructor(
    readonly root: string,
    readonly assets: string,
  ) {}
  async prepare(integration: string) {
    if (!packages[integration]) throw new Error('Unknown integration');
    if (!fs.existsSync(path.join(this.root, 'pyproject.toml')))
      throw new Error('Create a pyproject.toml before adding packages');
    if (
      ['poetry.lock', 'Pipfile.lock'].some((f) =>
        fs.existsSync(path.join(this.root, f)),
      )
    )
      throw new Error(
        'This project uses another package manager. Install the integration with that manager to preserve its lockfile.',
      );
    const id = crypto.randomUUID(),
      directory = within(this.root, `.aiide/integrations/${id}`, true);
    fs.mkdirSync(directory, { recursive: true });
    const baseline: Record<string, string | null> = {};
    for (const file of ['pyproject.toml', 'uv.lock']) {
      baseline[file] = fs.existsSync(path.join(this.root, file))
        ? fs.readFileSync(within(this.root, file), 'utf8')
        : null;
      if (baseline[file] !== null)
        fs.writeFileSync(path.join(directory, file), baseline[file]!);
    }
    try {
      await execute('uv', ['add', '--no-sync', ...packages[integration]], {
        cwd: directory,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      });
      const files = ['pyproject.toml', 'uv.lock'].map((file) => ({
        file,
        before: baseline[file],
        after: fs.readFileSync(path.join(directory, file), 'utf8'),
      }));
      const wrapper =
        'from aiide_sdk.langchain import AIIDECallbackHandler\n\n# Pass this to chain.invoke(..., config=AIIDE_CONFIG).\nAIIDE_CONFIG = {"callbacks": [AIIDECallbackHandler()]}\n';
      if (
        ['langchain', 'langgraph'].includes(integration) &&
        !fs.existsSync(path.join(this.root, 'aiide_instrumentation.py'))
      )
        files.push({
          file: 'aiide_instrumentation.py',
          before: null,
          after: wrapper,
        });
      this.plans.set(id, { files, directory });
      return {
        id,
        files,
        reviewHash: hash(JSON.stringify(files)),
        packages: packages[integration],
      };
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async apply(id: string, reviewHash: string) {
    const plan = this.plans.get(id);
    if (!plan || hash(JSON.stringify(plan.files)) !== reviewHash)
      throw new Error('Review the current integration plan first');
    for (const f of plan.files) {
      const current = fs.existsSync(path.join(this.root, f.file))
        ? fs.readFileSync(within(this.root, f.file), 'utf8')
        : null;
      if (current !== f.before)
        throw new Error(`Concurrent edit conflict: ${f.file}`);
    }
    const sdkTarget = within(this.root, 'aiide_sdk', true);
    const copySdk = !fs.existsSync(sdkTarget);
    try {
      if (copySdk)
        fs.cpSync(path.join(this.assets, 'python/aiide_sdk'), sdkTarget, {
          recursive: true,
          errorOnExist: true,
        });
      for (const f of plan.files)
        fs.writeFileSync(within(this.root, f.file, true), f.after);
    } catch (error) {
      for (const f of plan.files) {
        const target = within(this.root, f.file, true);
        if (f.before === null) fs.rmSync(target, { force: true });
        else fs.writeFileSync(target, f.before);
      }
      if (copySdk) fs.rmSync(sdkTarget, { recursive: true, force: true });
      throw error;
    }
    this.plans.delete(id);
    fs.rmSync(plan.directory, { recursive: true, force: true });
    // A failed installation retains the reviewed manifest/lock so uv sync --locked can be retried.
    await execute('uv', ['sync', '--locked'], {
      cwd: this.root,
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    });
    return { installed: true };
  }
}
