import { useEffect, useState } from 'react';

export const ROUTES = ['home', 'new', 'entities', 'preview'] as const;
export type Route = (typeof ROUTES)[number];

export function parseRoute(hash: string): Route {
  const match = /^#\/?([^?/]*)/.exec(hash);
  const candidate = match?.[1] ?? '';
  return ROUTES.find((route) => route === candidate) ?? 'home';
}

export function routeHref(route: Route): string {
  return `#/${route}`;
}

export function navigate(route: Route): void {
  window.location.hash = `/${route}`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
