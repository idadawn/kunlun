import { WEB_ROUTES, resolveRoute, type AppArea } from '../packages/shared/src/routes';

/**
 * Serves the React app's index for every declared clean route of the given areas (dev and preview),
 * redirects `/` to the home area and answers 404 for unknown pages and any `.html` URL.
 */
export function cleanRoutes(areas: AppArea[]) {
  const install = (server: any) => {
    server.middlewares.use((req: any, res: any, next: any) => {
      if (!['GET', 'HEAD'].includes(req.method || 'GET')) return next();
      const url = new URL(req.url || '/', 'http://localhost');
      const notFound = () => { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('页面不存在'); };
      if (url.pathname === '/') {
        res.statusCode = 308; res.setHeader('Location', '/' + areas[0] + url.search); res.end(); return;
      }
      if (url.pathname.endsWith('.html')) return notFound();
      const first = url.pathname.split('/')[1];
      if (!Object.hasOwn(WEB_ROUTES, first)) return next();
      const route = resolveRoute(url.pathname);
      if (!route || !areas.includes(route.area)) return notFound();
      req.url = '/index.html' + url.search;
      next();
    });
  };
  return { name: 'kunlun-clean-routes', configureServer: install, configurePreviewServer: install };
}
