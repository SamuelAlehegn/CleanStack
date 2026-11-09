export function titleCase(value: string): string {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export function databaseLabel(value: string): string {
  if (value === 'postgresql') return 'PostgreSQL';
  if (value === 'h2') return 'H2 in-memory';
  if (value === 'mysql') return 'MySQL';
  return titleCase(value);
}

export function authLabel(value: string): string {
  if (value === 'jwt') return 'JWT resource server';
  if (value === 'session') return 'Session login';
  if (value === 'oidc') return 'OIDC';
  if (value === 'keycloak') return 'Keycloak OIDC';
  if (value === 'auth0') return 'Auth0 OIDC';
  if (value === 'none') return 'No authentication';
  return titleCase(value);
}

export function buildToolLabel(value: string): string {
  return value === 'maven' ? 'Maven' : value === 'gradle' ? 'Gradle' : titleCase(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileTone(extension: string): string {
  switch (extension) {
    case 'java':
      return 'java';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'html':
      return 'html';
    case 'scss':
    case 'css':
      return 'style';
    case 'json':
    case 'yml':
    case 'yaml':
      return 'config';
    case 'md':
      return 'markdown';
    default:
      return 'default';
  }
}

export function fileLanguage(extension: string): string {
  switch (extension) {
    case 'java':
      return 'Java';
    case 'ts':
      return 'TypeScript';
    case 'tsx':
      return 'TSX';
    case 'js':
      return 'JavaScript';
    case 'html':
      return 'HTML';
    case 'scss':
      return 'SCSS';
    case 'css':
      return 'CSS';
    case 'json':
      return 'JSON';
    case 'yml':
    case 'yaml':
      return 'YAML';
    case 'md':
      return 'Markdown';
    case 'xml':
      return 'XML';
    case 'sql':
      return 'SQL';
    case 'sh':
      return 'Shell';
    default:
      return extension === '' ? 'Text' : extension.toUpperCase();
  }
}

export function stackLabel(project: { backend: boolean; frontend: boolean }): string {
  if (project.backend && project.frontend) return 'Full stack';
  if (project.backend) return 'Backend only';
  if (project.frontend) return 'Frontend only';
  return 'No generators';
}

export function commandPreview(args: string[]): string {
  return args
    .map((argument) =>
      /^[A-Za-z0-9_./:=@-]+$/.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`,
    )
    .join(' ');
}
