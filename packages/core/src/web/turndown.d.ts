declare module 'turndown' {
  export interface Options {
    headingStyle?: 'setext' | 'atx';
    codeBlockStyle?: 'indented' | 'fenced';
    bulletListMarker?: '-' | '+' | '*';
    emDelimiter?: '_' | '*';
    strongDelimiter?: '__' | '**';
  }

  export default class TurndownService {
    constructor(options?: Options);
    turndown(html: string): string;
  }
}
