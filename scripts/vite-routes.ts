import routes from '../config/web-routes.json';

export function cleanRoutes(defaultArea: 'admin' | 'member') {
  const config = routes as Record<string, { home: string; pages: string[]; aliases?: Record<string, string> }>;
  const install = (server: any) => {
    server.middlewares.use((req: any, res: any, next: any) => {
      if (!['GET','HEAD'].includes(req.method || 'GET')) return next();
      const url = new URL(req.url || '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const legacy = /^\/(admin|staff|member)\.html$/.exec(path);
      if (path === '/' || path === '/index.html' || legacy) {
        res.statusCode = 308;
        res.setHeader('Location', '/' + (legacy?.[1] || defaultArea) + url.search);
        res.end(); return;
      }
      const parts = path.replace(/\/index\.html$/, '').split('/').filter(Boolean);
      const area = parts[0];
      if (!config[area]) return next();
      const page = config[area].aliases?.[parts[1]] || parts[1] || config[area].home;
      if (parts.length > 2 || !config[area].pages.includes(page)) {
        res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('页面不存在'); return;
      }
      req.url = '/' + area + '.html' + url.search;
      next();
    });
  };
  return { name: 'kunlun-clean-routes', configureServer: install, configurePreviewServer: install };
}
