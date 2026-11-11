import type { EntityModel } from './entity-model.js';
import { detectLineEnding, type LineEnding } from '../utils/text.js';

const ROUTES_MARKER = '// </cleanstack:entity-routes>';
const NAV_MARKER = '<!-- </cleanstack:entity-nav> -->';

/** Returns whether app.routes.ts already declares the entity list route. */
export function hasEntityRoutes(source: string, entity: Pick<EntityModel, 'routeName'>): boolean {
  return new RegExp(`path:\\s*'${escapeRegExp(entity.routeName)}'`).test(source);
}

/** Returns whether the layout already links to the entity list route. */
export function hasEntityNavLink(source: string, entity: Pick<EntityModel, 'routeName'>): boolean {
  return source.includes(`routerLink="/${entity.routeName}"`);
}

/** Inserts the list, create, detail, and edit routes for an entity. */
export function addEntityRoutes(source: string, entity: EntityModel): string {
  const lineEnding = detectLineEnding(source) ?? '\n';
  const block = routeBlock(entity, lineEnding);

  if (source.includes(ROUTES_MARKER)) {
    return insertBefore(source, source.indexOf(ROUTES_MARKER), block, lineEnding);
  }

  const childrenIndex = source.indexOf('children: [');
  if (childrenIndex !== -1) {
    const open = source.indexOf('[', childrenIndex);
    const close = findMatchingBracket(source, open);
    if (close !== -1) return insertBefore(source, close, block, lineEnding);
  }

  const routesIndex = source.indexOf('export const routes');
  if (routesIndex !== -1) {
    const open = source.indexOf('[', routesIndex);
    const close = findMatchingBracket(source, open);
    if (close !== -1) return insertBefore(source, close, block, lineEnding);
  }

  throw new Error(
    'Could not find the route array in app.routes.ts. Add the entity route manually.',
  );
}

/** Inserts the entity list link into the application layout navigation. */
export function addEntityNavLink(source: string, entity: EntityModel): string {
  const lineEnding = detectLineEnding(source) ?? '\n';
  const block = navLinkBlock(entity, lineEnding);

  if (source.includes(NAV_MARKER)) {
    return insertBefore(source, source.indexOf(NAV_MARKER), block, lineEnding);
  }

  const navClose = source.lastIndexOf('</nav>');
  if (navClose !== -1) return insertBefore(source, navClose, block, lineEnding);

  throw new Error(
    'Could not find the navigation in app-layout.component.html. Add the entity link manually.',
  );
}

function routeBlock(entity: EntityModel, lineEnding: LineEnding): string {
  const route = entity.routeName;
  const component = entity.className;
  return [
    '      {',
    `        path: '${route}',`,
    `        title: '${escapeSingleQuote(entity.pluralName)}',`,
    '        loadComponent: () =>',
    `          import('./pages/${route}/list/list.component').then(`,
    `            (module) => module.${component}ListComponent,`,
    '          ),',
    '      },',
    '      {',
    `        path: '${route}/new',`,
    `        title: 'New ${escapeSingleQuote(entity.name)}',`,
    '        loadComponent: () =>',
    `          import('./pages/${route}/form/form.component').then(`,
    `            (module) => module.${component}FormComponent,`,
    '          ),',
    '      },',
    '      {',
    `        path: '${route}/:id',`,
    `        title: '${escapeSingleQuote(entity.name)} details',`,
    '        loadComponent: () =>',
    `          import('./pages/${route}/detail/detail.component').then(`,
    `            (module) => module.${component}DetailComponent,`,
    '          ),',
    '      },',
    '      {',
    `        path: '${route}/:id/edit',`,
    `        title: 'Edit ${escapeSingleQuote(entity.name)}',`,
    '        loadComponent: () =>',
    `          import('./pages/${route}/form/form.component').then(`,
    `            (module) => module.${component}FormComponent,`,
    '          ),',
    '      },',
  ].join(lineEnding);
}

function navLinkBlock(entity: EntityModel, lineEnding: LineEnding): string {
  return [
    `      <a routerLink="/${entity.routeName}" routerLinkActive="nav-link-active" (click)="closeMenu()">`,
    '        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 5.5h12M4 10h12M4 14.5h8"/></svg>',
    `        <span>${escapeHtml(entity.pluralName)}</span>`,
    '      </a>',
  ].join(lineEnding);
}

function insertBefore(
  source: string,
  index: number,
  block: string,
  lineEnding: LineEnding,
): string {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const prefix = source.slice(lineStart, index);
  if (prefix.trim() === '') {
    return `${source.slice(0, lineStart)}${block}${lineEnding}${source.slice(lineStart)}`;
  }
  return `${source.slice(0, index)}${lineEnding}${block}${lineEnding}${source.slice(index)}`;
}

function findMatchingBracket(source: string, openIndex: number): number {
  if (openIndex === -1) return -1;
  let depth = 0;
  let inString: "'" | '"' | '`' | undefined;

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (character === '\\') {
        index += 1;
      } else if (character === inString) {
        inString = undefined;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      inString = character;
    } else if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function escapeSingleQuote(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
