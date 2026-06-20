import { execFile } from 'child_process';
import { promisify } from 'util';
import { DesktopAgentSettings, ToolRequest, ToolResult } from '../agent/types';

const execFileAsync = promisify(execFile);

export async function runInputTool(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  if (!['keyboard_mouse', 'automation'].includes(settings.controlMode)) {
    return { ok: false, error: 'Keyboard and mouse control is disabled' };
  }

  try {
    switch (request.tool) {
      case 'input.type_text':
        return await typeText(request);
      case 'input.hotkey':
        return await hotkey(request);
      case 'input.press_key':
        return await pressKey(request);
      case 'input.click':
        return await click(request);
      case 'input.drag':
        return await drag(request);
      case 'input.scroll':
        return await scroll(request);
      default:
        return { ok: false, error: `Unsupported input tool: ${request.tool}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function typeText(request: ToolRequest): Promise<ToolResult> {
  const args = request.args as { text?: string };
  if (typeof args?.text !== 'string') {
    return { ok: false, error: 'text is required' };
  }

  await runAppleScript(`tell application "System Events" to keystroke ${appleScriptString(args.text)}`);
  return { ok: true, result: { typedCharacters: args.text.length } };
}

async function hotkey(request: ToolRequest): Promise<ToolResult> {
  const args = request.args as { key?: string; modifiers?: string[] };
  if (!args?.key) return { ok: false, error: 'key is required' };

  const modifiers = (args.modifiers || []).map(normalizeModifier);
  const usingClause = modifiers.length ? ` using {${modifiers.join(', ')}}` : '';
  await runAppleScript(`tell application "System Events" to keystroke ${appleScriptString(args.key)}${usingClause}`);

  return {
    ok: true,
    result: {
      key: args.key,
      modifiers: args.modifiers || [],
    },
  };
}

async function pressKey(request: ToolRequest): Promise<ToolResult> {
  const args = request.args as { key?: string; modifiers?: string[] };
  if (!args?.key) return { ok: false, error: 'key is required' };

  const keyCode = normalizeKeyCode(args.key);
  const modifiers = (args.modifiers || []).map(normalizeModifier);
  const usingClause = modifiers.length ? ` using {${modifiers.join(', ')}}` : '';
  await runAppleScript(`tell application "System Events" to key code ${keyCode.code}${usingClause}`);

  return {
    ok: true,
    result: {
      key: keyCode.name,
      modifiers: args.modifiers || [],
    },
  };
}

async function click(request: ToolRequest): Promise<ToolResult> {
  const args = request.args as { x?: number; y?: number; button?: string; clickCount?: number };
  if (typeof args?.x !== 'number' || typeof args?.y !== 'number') {
    return { ok: false, error: 'x and y coordinates are required' };
  }

  const button = normalizeMouseButton(args.button || 'left');
  const clickCount = Math.round(clampNumber(args.clickCount || 1, 1, 3));
  const x = Math.round(args.x);
  const y = Math.round(args.y);

  await runCoreGraphicsScript(`
const x = ${x};
const y = ${y};
const button = ${button.cgButton};
const downEvent = ${button.downEvent};
const upEvent = ${button.upEvent};
postMouse($.kCGEventMouseMoved, x, y, button);
for (let index = 1; index <= ${clickCount}; index += 1) {
  postMouse(downEvent, x, y, button, index);
  postMouse(upEvent, x, y, button, index);
  delay(0.05);
}
`);

  return {
    ok: true,
    result: {
      x,
      y,
      button: button.name,
      clickCount,
    },
  };
}

async function drag(request: ToolRequest): Promise<ToolResult> {
  const args = request.args as {
    fromX?: number;
    fromY?: number;
    toX?: number;
    toY?: number;
    durationMs?: number;
  };

  if (
    typeof args?.fromX !== 'number' ||
    typeof args?.fromY !== 'number' ||
    typeof args?.toX !== 'number' ||
    typeof args?.toY !== 'number'
  ) {
    return { ok: false, error: 'fromX, fromY, toX, and toY coordinates are required' };
  }

  const durationMs = clampNumber(args.durationMs || 250, 0, 10000);
  const fromX = Math.round(args.fromX);
  const fromY = Math.round(args.fromY);
  const toX = Math.round(args.toX);
  const toY = Math.round(args.toY);
  await runCoreGraphicsScript(`
const fromX = ${fromX};
const fromY = ${fromY};
const toX = ${toX};
const toY = ${toY};
const durationMs = ${durationMs};
postMouse($.kCGEventMouseMoved, fromX, fromY);
postMouse($.kCGEventLeftMouseDown, fromX, fromY, $.kCGMouseButtonLeft);
const steps = Math.max(1, Math.min(40, Math.ceil(durationMs / 25)));
for (let step = 1; step <= steps; step += 1) {
  const ratio = step / steps;
  postMouse(
    $.kCGEventLeftMouseDragged,
    Math.round(fromX + ((toX - fromX) * ratio)),
    Math.round(fromY + ((toY - fromY) * ratio)),
    $.kCGMouseButtonLeft,
  );
  delay(durationMs / steps / 1000);
}
postMouse($.kCGEventLeftMouseUp, toX, toY, $.kCGMouseButtonLeft);
`);

  return {
    ok: true,
    result: {
      fromX,
      fromY,
      toX,
      toY,
      durationMs,
    },
  };
}

async function scroll(request: ToolRequest): Promise<ToolResult> {
  const args = request.args as { deltaY?: number; deltaX?: number; x?: number; y?: number };
  if (typeof args?.deltaY !== 'number') {
    return { ok: false, error: 'deltaY is required' };
  }

  const deltaX = Math.round(clampNumber(args.deltaX || 0, -10000, 10000));
  const deltaY = Math.round(clampNumber(args.deltaY || 0, -10000, 10000));
  const x = typeof args.x === 'number' ? Math.round(args.x) : undefined;
  const y = typeof args.y === 'number' ? Math.round(args.y) : undefined;

  await runCoreGraphicsScript(`
${x !== undefined && y !== undefined ? `postMouse($.kCGEventMouseMoved, ${x}, ${y});` : ''}
const event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitPixel, 2, ${deltaY}, ${deltaX});
$.CGEventPost($.kCGHIDEventTap, event);
`);

  return {
    ok: true,
    result: {
      deltaX,
      deltaY,
      ...(x !== undefined && y !== undefined ? { x, y } : {}),
    },
  };
}

async function runAppleScript(script: string): Promise<void> {
  await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 10000 });
}

async function runCoreGraphicsScript(body: string): Promise<void> {
  const script = `
ObjC.import('CoreGraphics');
function point(x, y) {
  return $.CGPointMake(x, y);
}
function postMouse(type, x, y, button) {
  const event = $.CGEventCreateMouseEvent(null, type, point(x, y), button || $.kCGMouseButtonLeft);
  if (arguments.length >= 5) {
    $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, arguments[4]);
  }
  $.CGEventPost($.kCGHIDEventTap, event);
}
${body}
`;

  await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 15000 });
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function normalizeMouseButton(button: string): {
  name: 'left' | 'right' | 'middle';
  cgButton: string;
  downEvent: string;
  upEvent: string;
} {
  switch (button.toLowerCase()) {
    case 'left':
      return {
        name: 'left',
        cgButton: '$.kCGMouseButtonLeft',
        downEvent: '$.kCGEventLeftMouseDown',
        upEvent: '$.kCGEventLeftMouseUp',
      };
    case 'right':
      return {
        name: 'right',
        cgButton: '$.kCGMouseButtonRight',
        downEvent: '$.kCGEventRightMouseDown',
        upEvent: '$.kCGEventRightMouseUp',
      };
    case 'middle':
      return {
        name: 'middle',
        cgButton: '$.kCGMouseButtonCenter',
        downEvent: '$.kCGEventOtherMouseDown',
        upEvent: '$.kCGEventOtherMouseUp',
      };
    default:
      throw new Error(`Unsupported mouse button: ${button}`);
  }
}

function normalizeModifier(modifier: string): string {
  switch (modifier.toLowerCase()) {
    case 'cmd':
    case 'command':
    case 'meta':
      return 'command down';
    case 'shift':
      return 'shift down';
    case 'alt':
    case 'option':
      return 'option down';
    case 'ctrl':
    case 'control':
      return 'control down';
    default:
      throw new Error(`Unsupported modifier: ${modifier}`);
  }
}

function normalizeKeyCode(key: string): { name: string; code: number } {
  const normalized = key.toLowerCase().replace(/[\s_-]/g, '');
  const fixedKeyCodes: Record<string, { name: string; code: number }> = {
    return: { name: 'return', code: 36 },
    enter: { name: 'return', code: 36 },
    tab: { name: 'tab', code: 48 },
    escape: { name: 'escape', code: 53 },
    esc: { name: 'escape', code: 53 },
    space: { name: 'space', code: 49 },
    delete: { name: 'delete', code: 51 },
    backspace: { name: 'delete', code: 51 },
    forwarddelete: { name: 'forward_delete', code: 117 },
    up: { name: 'up', code: 126 },
    arrowup: { name: 'up', code: 126 },
    down: { name: 'down', code: 125 },
    arrowdown: { name: 'down', code: 125 },
    left: { name: 'left', code: 123 },
    arrowleft: { name: 'left', code: 123 },
    right: { name: 'right', code: 124 },
    arrowright: { name: 'right', code: 124 },
    home: { name: 'home', code: 115 },
    end: { name: 'end', code: 119 },
    pageup: { name: 'page_up', code: 116 },
    pagedown: { name: 'page_down', code: 121 },
  };

  if (fixedKeyCodes[normalized]) return fixedKeyCodes[normalized];

  const functionKeyCodes: Record<string, number> = {
    f1: 122,
    f2: 120,
    f3: 99,
    f4: 118,
    f5: 96,
    f6: 97,
    f7: 98,
    f8: 100,
    f9: 101,
    f10: 109,
    f11: 103,
    f12: 111,
  };
  if (functionKeyCodes[normalized]) return { name: normalized, code: functionKeyCodes[normalized] };

  throw new Error(`Unsupported key: ${key}`);
}
