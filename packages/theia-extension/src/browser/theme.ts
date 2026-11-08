import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { MonacoThemingService } from '@theia/monaco/lib/browser/monaco-theming-service';

export const MONO_THEME_ID = 'aiide-black';

// Deep black surfaces, bright white ink, grey steps in between. Red/amber kept only for errors/warnings.
const bg = '#000000';
const surface = '#0a0a0a';
const raised = '#141414';
const line = '#1f1f1f';
const lineStrong = '#2e2e2e';
const muted = '#7a7a7a';
const text = '#e6e6e6';
const white = '#ffffff';
const danger = '#ff6b6b';
const warn = '#d9b45a';

const colors: Record<string, string> = {
  foreground: text,
  descriptionForeground: muted,
  errorForeground: danger,
  focusBorder: '#ffffff55',
  'widget.border': line,
  'widget.shadow': '#00000000',
  'selection.background': '#ffffff33',
  'icon.foreground': '#bdbdbd',
  'sash.hoverBorder': lineStrong,
  'textLink.foreground': white,
  'textLink.activeForeground': white,
  'progressBar.background': white,

  'editor.background': bg,
  'editor.foreground': text,
  'editorLineNumber.foreground': '#3d3d3d',
  'editorLineNumber.activeForeground': white,
  'editorCursor.foreground': white,
  'editor.selectionBackground': '#ffffff26',
  'editor.inactiveSelectionBackground': '#ffffff14',
  'editor.selectionHighlightBackground': '#ffffff12',
  'editor.wordHighlightBackground': '#ffffff12',
  'editor.findMatchBackground': '#ffffff40',
  'editor.findMatchHighlightBackground': '#ffffff1a',
  'editor.lineHighlightBackground': '#0d0d0d',
  'editor.lineHighlightBorder': '#00000000',
  'editorIndentGuide.background1': '#161616',
  'editorIndentGuide.activeBackground1': lineStrong,
  'editorWhitespace.foreground': '#262626',
  'editorBracketMatch.background': '#ffffff14',
  'editorBracketMatch.border': '#ffffff40',
  'editorBracketHighlight.foreground1': '#bfbfbf',
  'editorBracketHighlight.foreground2': '#8c8c8c',
  'editorBracketHighlight.foreground3': '#666666',
  'editorBracketHighlight.foreground4': '#bfbfbf',
  'editorBracketHighlight.foreground5': '#8c8c8c',
  'editorBracketHighlight.foreground6': '#666666',
  'editorBracketHighlight.unexpectedBracket.foreground': danger,
  'editorInlayHint.background': '#111111',
  'editorInlayHint.foreground': '#6b6b6b',
  'editorGutter.background': bg,
  'editorWidget.background': surface,
  'editorWidget.border': line,
  'editorHoverWidget.background': surface,
  'editorHoverWidget.border': line,
  'editorSuggestWidget.background': surface,
  'editorSuggestWidget.border': line,
  'editorSuggestWidget.selectedBackground': raised,
  'editorSuggestWidget.highlightForeground': white,
  'editorError.foreground': danger,
  'editorWarning.foreground': warn,
  'editorInfo.foreground': '#bdbdbd',
  'editorGroup.border': line,
  'editorGroupHeader.tabsBackground': bg,
  'editorGroupHeader.tabsBorder': line,
  'editorOverviewRuler.border': '#00000000',
  'scrollbar.shadow': '#00000000',
  'scrollbarSlider.background': '#ffffff14',
  'scrollbarSlider.hoverBackground': '#ffffff26',
  'scrollbarSlider.activeBackground': '#ffffff3d',
  'minimap.background': bg,

  'tab.activeBackground': bg,
  'tab.activeForeground': white,
  'tab.activeBorderTop': white,
  'tab.inactiveBackground': bg,
  'tab.inactiveForeground': muted,
  'tab.border': bg,
  'tab.hoverBackground': surface,
  'tab.unfocusedActiveForeground': text,
  'tab.unfocusedActiveBorderTop': lineStrong,

  'activityBar.background': bg,
  'activityBar.foreground': white,
  'activityBar.inactiveForeground': '#5c5c5c',
  'activityBar.border': line,
  'activityBar.activeBorder': white,
  'activityBarBadge.background': white,
  'activityBarBadge.foreground': bg,

  'sideBar.background': bg,
  'sideBar.foreground': text,
  'sideBar.border': line,
  'sideBarTitle.foreground': muted,
  'sideBarSectionHeader.background': bg,
  'sideBarSectionHeader.foreground': muted,
  'sideBarSectionHeader.border': line,

  'list.activeSelectionBackground': '#1a1a1a',
  'list.activeSelectionForeground': white,
  'list.inactiveSelectionBackground': '#121212',
  'list.inactiveSelectionForeground': text,
  'list.hoverBackground': '#0f0f0f',
  'list.focusOutline': '#ffffff33',
  'list.highlightForeground': white,
  'list.errorForeground': danger,
  'list.warningForeground': warn,
  'tree.indentGuidesStroke': lineStrong,

  'titleBar.activeBackground': bg,
  'titleBar.activeForeground': text,
  'titleBar.inactiveBackground': bg,
  'titleBar.inactiveForeground': muted,
  'titleBar.border': line,
  'menubar.selectionBackground': raised,
  'menu.background': surface,
  'menu.foreground': text,
  'menu.selectionBackground': '#1f1f1f',
  'menu.selectionForeground': white,
  'menu.separatorBackground': line,
  'menu.border': line,

  'statusBar.background': bg,
  'statusBar.foreground': muted,
  'statusBar.border': line,
  'statusBar.noFolderBackground': bg,
  'statusBar.debuggingBackground': white,
  'statusBar.debuggingForeground': bg,
  'statusBarItem.hoverBackground': raised,
  'statusBarItem.remoteBackground': bg,
  'statusBarItem.remoteForeground': white,

  'panel.background': bg,
  'panel.border': line,
  'panelTitle.activeForeground': white,
  'panelTitle.activeBorder': white,
  'panelTitle.inactiveForeground': muted,

  'input.background': surface,
  'input.foreground': text,
  'input.border': line,
  'input.placeholderForeground': '#555555',
  'inputOption.activeBorder': white,
  'inputValidation.errorBorder': danger,
  'dropdown.background': surface,
  'dropdown.border': line,
  'dropdown.foreground': text,
  'checkbox.background': surface,
  'checkbox.border': lineStrong,

  'button.background': white,
  'button.foreground': bg,
  'button.hoverBackground': '#d9d9d9',
  'button.secondaryBackground': raised,
  'button.secondaryForeground': text,
  'button.secondaryHoverBackground': '#1f1f1f',
  'badge.background': white,
  'badge.foreground': bg,

  'quickInput.background': surface,
  'quickInput.foreground': text,
  'quickInputTitle.background': raised,
  'pickerGroup.foreground': muted,
  'pickerGroup.border': line,
  'quickInputList.focusBackground': '#1a1a1a',
  'quickInputList.focusForeground': white,

  'notifications.background': surface,
  'notifications.border': line,
  'notificationCenterHeader.background': raised,
  'notificationToast.border': line,

  'terminal.background': bg,
  'terminal.foreground': text,
  'terminalCursor.foreground': white,
  'terminal.selectionBackground': '#ffffff33',
  'terminal.ansiBlack': '#000000',
  'terminal.ansiBrightBlack': '#5c5c5c',
  'terminal.ansiWhite': '#d4d4d4',
  'terminal.ansiBrightWhite': white,
  'terminal.ansiRed': danger,
  'terminal.ansiBrightRed': '#ff8f8f',
  'terminal.ansiGreen': '#bfbfbf',
  'terminal.ansiBrightGreen': white,
  'terminal.ansiYellow': warn,
  'terminal.ansiBrightYellow': '#e8cc85',
  'terminal.ansiBlue': '#a6a6a6',
  'terminal.ansiBrightBlue': '#d9d9d9',
  'terminal.ansiMagenta': '#9e9e9e',
  'terminal.ansiBrightMagenta': '#cfcfcf',
  'terminal.ansiCyan': '#b3b3b3',
  'terminal.ansiBrightCyan': '#e0e0e0',

  'gitDecoration.modifiedResourceForeground': '#d4d4d4',
  'gitDecoration.untrackedResourceForeground': white,
  'gitDecoration.deletedResourceForeground': danger,
  'gitDecoration.ignoredResourceForeground': '#4d4d4d',
  'editorGutter.modifiedBackground': '#8a8a8a',
  'editorGutter.addedBackground': '#d9d9d9',
  'editorGutter.deletedBackground': danger,
  'diffEditor.insertedTextBackground': '#ffffff14',
  'diffEditor.removedTextBackground': '#ff6b6b1f',
};

const tokenColors = [
  { settings: { foreground: text } },
  {
    scope: ['comment', 'punctuation.definition.comment'],
    settings: { foreground: '#5c5c5c', fontStyle: 'italic' },
  },
  {
    scope: ['keyword', 'storage', 'storage.type', 'keyword.control'],
    settings: { foreground: white, fontStyle: 'bold' },
  },
  {
    scope: ['string', 'string.quoted', 'string.template'],
    settings: { foreground: '#a6a6a6' },
  },
  {
    scope: ['constant.numeric', 'constant.language', 'constant.character'],
    settings: { foreground: '#d9d9d9' },
  },
  {
    scope: ['entity.name.function', 'support.function', 'meta.function-call'],
    settings: { foreground: white },
  },
  {
    scope: [
      'entity.name.type',
      'entity.name.class',
      'support.type',
      'support.class',
    ],
    settings: { foreground: '#cccccc', fontStyle: 'italic' },
  },
  {
    scope: ['variable', 'variable.parameter', 'meta.definition.variable'],
    settings: { foreground: text },
  },
  {
    scope: ['punctuation', 'meta.brace', 'keyword.operator'],
    settings: { foreground: '#8c8c8c' },
  },
  { scope: ['entity.name.tag'], settings: { foreground: white } },
  {
    scope: ['entity.other.attribute-name'],
    settings: { foreground: '#b3b3b3' },
  },
  { scope: ['invalid'], settings: { foreground: danger } },
  {
    scope: ['markup.heading'],
    settings: { foreground: white, fontStyle: 'bold' },
  },
  { scope: ['markup.inserted'], settings: { foreground: white } },
  { scope: ['markup.deleted'], settings: { foreground: danger } },
];

@injectable()
export class MonochromeTheme implements FrontendApplicationContribution {
  @inject(MonacoThemingService)
  protected readonly theming!: MonacoThemingService;
  initialize() {
    this.theming.registerParsedTheme({
      id: MONO_THEME_ID,
      label: 'AI IDE Black',
      uiTheme: 'vs-dark',
      json: { type: 'dark', colors, tokenColors, semanticHighlighting: false },
    });
  }
}
