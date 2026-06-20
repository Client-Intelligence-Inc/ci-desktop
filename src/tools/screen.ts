import { desktopCapturer, screen as electronScreen } from 'electron';
import { DesktopAgentSettings, ToolRequest, ToolResult } from '../agent/types';

export async function runScreenTool(
  request: ToolRequest,
  settings: DesktopAgentSettings,
): Promise<ToolResult> {
  if (!['screen', 'keyboard_mouse', 'automation'].includes(settings.controlMode)) {
    return { ok: false, error: 'Screen access is disabled by desktop agent policy' };
  }

  if (request.tool === 'screen.sources') {
    return listScreenSources(request);
  }

  if (request.tool !== 'screen.screenshot') {
    return { ok: false, error: `Unsupported screen tool: ${request.tool}` };
  }

  const args = request.args as {
    width?: number;
    height?: number;
    sourceId?: string;
    format?: string;
    quality?: number;
  };
  const width = Math.min(Math.max(args?.width || 1440, 320), 3840);
  const height = Math.min(Math.max(args?.height || 900, 200), 2160);
  const encoding = normalizeEncoding(args?.format, args?.quality);

  const sourceTypes: Array<'screen' | 'window'> = args?.sourceId ? ['screen', 'window'] : ['screen'];
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: sourceTypes,
      thumbnailSize: { width, height },
    });
  } catch (error) {
    return {
      ok: false,
      error: screenCaptureError(error),
    };
  }

  const source = args?.sourceId
    ? sources.find((candidate) => candidate.id === args.sourceId)
    : sources[0];

  if (!source) {
    return { ok: false, error: 'No screen source is available' };
  }

  const size = source.thumbnail.getSize();
  if (size.width <= 0 || size.height <= 0) {
    return {
      ok: false,
      error: 'Screen capture returned an empty image. Re-grant Screen Recording to /Applications/Client Intelligence.app, then quit and reopen the app.',
    };
  }

  return {
    ok: true,
    result: {
      sourceId: source.id,
      name: source.name,
      sourceType: source.id.startsWith('screen:') ? 'screen' : 'window',
      displayId: source.display_id || undefined,
      ...getScreenGeometry(source.display_id),
      mimeType: encoding.mimeType,
      format: encoding.format,
      quality: encoding.format === 'jpeg' ? encoding.quality : undefined,
      width: size.width,
      height: size.height,
      data: encodeThumbnail(source.thumbnail, encoding).toString('base64'),
    },
  };
}

async function listScreenSources(request: ToolRequest): Promise<ToolResult> {
  const args = request.args as { includeWindows?: boolean };
  const types: Array<'screen' | 'window'> = args?.includeWindows ? ['screen', 'window'] : ['screen'];
  const sources = await desktopCapturer.getSources({
    types,
    thumbnailSize: { width: 1, height: 1 },
  });

  return {
    ok: true,
    result: {
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        type: source.id.startsWith('screen:') ? 'screen' : 'window',
        displayId: source.display_id || undefined,
        ...getScreenGeometry(source.display_id),
      })),
      count: sources.length,
    },
  };
}

function getScreenGeometry(displayId?: string): {
  bounds?: { x: number; y: number; width: number; height: number };
  scaleFactor?: number;
} {
  if (!displayId) return {};
  const display = electronScreen.getAllDisplays().find((candidate) => (
    String(candidate.id) === String(displayId)
  ));
  if (!display) return {};

  return {
    bounds: {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    },
    scaleFactor: display.scaleFactor,
  };
}

function normalizeEncoding(format?: string, quality?: number): {
  format: 'png' | 'jpeg';
  mimeType: 'image/png' | 'image/jpeg';
  quality: number;
} {
  const normalizedFormat = String(format || 'png').toLowerCase();
  if (normalizedFormat !== 'png' && normalizedFormat !== 'jpeg' && normalizedFormat !== 'jpg') {
    throw new Error('screen.screenshot format must be png or jpeg');
  }

  const resolvedFormat = normalizedFormat === 'jpg' ? 'jpeg' : normalizedFormat;
  const resolvedQuality = Math.round(Math.min(Math.max(quality || 75, 1), 100));

  return {
    format: resolvedFormat,
    mimeType: resolvedFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
    quality: resolvedQuality,
  };
}

function encodeThumbnail(
  thumbnail: { toJPEG(quality: number): Buffer; toPNG(): Buffer },
  encoding: { format: 'png' | 'jpeg'; quality: number },
): Buffer {
  if (encoding.format === 'jpeg') {
    return thumbnail.toJPEG(encoding.quality);
  }

  return thumbnail.toPNG();
}

function screenCaptureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    ? `Screen capture failed: ${message}`
    : 'Screen capture failed. Re-grant Screen Recording to /Applications/Client Intelligence.app, then quit and reopen the app.';
}
