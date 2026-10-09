/**
 * Minimal ambient declaration for `jsdom`, which ships without type
 * definitions. Only the surface the DOM shim uses is declared; the window is
 * typed loosely because the shim deliberately bridges into untyped
 * browser-shaped globals.
 */
declare module "jsdom" {
  export interface JSDOMOptions {
    pretendToBeVisual?: boolean;
    url?: string;
    [key: string]: unknown;
  }

  export class JSDOM {
    constructor(html?: string | Buffer, options?: JSDOMOptions);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window: any;
  }
}
