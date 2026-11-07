import {
  ContainerModule,
  inject,
  injectable,
} from '@theia/core/shared/inversify';
import { CommandRegistry, MenuModelRegistry } from '@theia/core/lib/common';
import {
  AbstractViewContribution,
  bindViewContribution,
  FrontendApplicationContribution,
  WidgetFactory,
  WebSocketConnectionProvider,
  CommonMenus,
  KeybindingRegistry,
  StatusBar,
  StatusBarAlignment,
} from '@theia/core/lib/browser';
import { EngineeringService, servicePath } from '../common/protocol.js';
import { EngineeringWidget } from './workbench.js';
import { ModelBridge } from './model-bridge.js';
import { MonochromeTheme } from './theme.js';
import '../../style/workbench.css';
import '../../style/monochrome.css';

const openEngineering = {
  id: 'aiide.open',
  label: 'Open AI Engineering',
  category: 'View',
};

@injectable()
class EngineeringContribution
  extends AbstractViewContribution<EngineeringWidget>
  implements FrontendApplicationContribution
{
  @inject(StatusBar) protected readonly statusBar!: StatusBar;
  constructor() {
    super({
      widgetId: EngineeringWidget.ID,
      widgetName: 'AI Engineering',
      defaultWidgetOptions: { area: 'main' },
    });
  }
  async initializeLayout() {
    await this.openView({ activate: true });
  }
  async onDidInitializeLayout() {
    const widget = this.tryGetWidget();
    if (!widget || !this.shell.getTabBarFor(widget)) {
      await this.openView({ activate: true });
    }
  }
  onStart() {
    void this.statusBar.setElement('aiide.open', {
      text: '$(beaker) AI Engineering',
      name: 'AI Engineering',
      tooltip: 'Open AI Engineering — runs, traces, models, and training',
      alignment: StatusBarAlignment.LEFT,
      priority: 100,
      command: openEngineering.id,
      accessibilityInformation: { label: 'Open AI Engineering' },
    });
  }
  registerCommands(commands: CommandRegistry) {
    super.registerCommands(commands);
    commands.registerCommand(openEngineering, {
      execute: () => this.openView({ activate: true }),
    });
  }
  registerMenus(menus: MenuModelRegistry) {
    super.registerMenus(menus);
    menus.registerMenuAction(CommonMenus.VIEW_PRIMARY, {
      commandId: openEngineering.id,
    });
  }
  registerKeybindings(keybindings: KeybindingRegistry) {
    keybindings.registerKeybinding({
      command: openEngineering.id,
      keybinding: 'ctrlcmd+alt+e',
    });
  }
}
export default new ContainerModule((bind) => {
  bind(EngineeringService)
    .toDynamicValue((ctx) =>
      WebSocketConnectionProvider.createProxy(ctx.container, servicePath),
    )
    .inSingletonScope();
  bind(EngineeringWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue((ctx) => ({
      id: EngineeringWidget.ID,
      createWidget: () => ctx.container.get(EngineeringWidget),
    }))
    .inSingletonScope();
  bindViewContribution(bind, EngineeringContribution);
  bind(FrontendApplicationContribution).toService(EngineeringContribution);
  bind(ModelBridge).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ModelBridge);
  bind(FrontendApplicationContribution).to(MonochromeTheme).inSingletonScope();
});
