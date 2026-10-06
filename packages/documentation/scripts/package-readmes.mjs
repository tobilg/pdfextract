import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Converter, MinimalSourceFile, normalizePath, ReflectionKind } from 'typedoc';

/** Attach package READMEs to their module pages without creating document subpages. */
export function load(app) {
  app.converter.on(Converter.EVENT_CREATE_DECLARATION, (context, reflection) => {
    if (!reflection.kindOf(ReflectionKind.Module)) return;
    const match = /^@pdfextract\/(core|ocr|storage)$/.exec(reflection.name);
    if (!match) return;

    const path = normalizePath(
      fileURLToPath(new URL(`../../${match[1]}/README.md`, import.meta.url)),
    );
    app.watchFile(path);
    // The module already has a page title; keep the README's sections below it.
    const markdown = readFileSync(path, 'utf8').replace(/^# [^\r\n]+\r?\n+/, '');
    const { content } = app.converter.parseRawComment(
      new MinimalSourceFile(markdown, path),
      context.project.files,
    );
    reflection.readme = content;
    // Resolve ordinary Markdown links, including section anchors, to this module.
    context.project.files.registerReflectionPath(path, reflection);
  });
}
