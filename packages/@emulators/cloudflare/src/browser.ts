import { renderWidgetPage, type AppEnv, type Hono } from "@emulators/core";

export function browserRoutes(app: Hono<AppEnv>): void {
  app.get("/turnstile/v0/api.js", (c) =>
    c.text(
      String.raw`(function () {
    const base = new URL('.', document.currentScript.src), widgets = new Map();
    let sequence = 0;
    function resolve(target) {
      if (target === undefined) return widgets.values().next().value;
      if (widgets.has(target)) return widgets.get(target);
      const element = typeof target === 'string' ? document.querySelector(target) : target;
      return [...widgets.values()].find(widget => widget.host === element);
    }
    function mount(widget) {
      clearTimeout(widget.timer);
      widget.token = ''; widget.expired = false; widget.input.value = '';
      if (widget.frame) widget.frame.remove();
      const frame = document.createElement('iframe');
      frame.title = 'Cloudflare Turnstile emulator'; frame.width = '300'; frame.height = '65';
      frame.setAttribute('frameborder', '0');
      const url = new URL('widget', base);
      url.searchParams.set('config', JSON.stringify({sitekey:widget.options.sitekey, origin:location.origin,
        action:widget.options.action, cData:widget.options.cData}));
      frame.src = url.href; widget.frame = frame; widget.host.appendChild(frame);
    }
    window.addEventListener('message', event => {
      if (event.origin !== base.origin || event.data?.emulate !== 'turnstile') return;
      const widget = [...widgets.values()].find(widget => widget.frame.contentWindow === event.source);
      if (!widget) return;
      if (event.data.error) { widget.options['error-callback']?.(event.data.error); return; }
      if (widget.token || typeof event.data.token !== 'string') return;
      widget.token = event.data.token; widget.input.value = widget.token;
      widget.timer = setTimeout(() => {
        widget.token = ''; widget.input.value = ''; widget.expired = true;
        widget.options['expired-callback']?.();
      }, 300000);
      widget.options.callback?.(widget.token);
    });
    window.turnstile = {
      ready(callback) { queueMicrotask(callback); },
      render(target, options) {
        const host = typeof target === 'string' ? document.querySelector(target) : target;
        if (!host) throw new Error('Missing Turnstile container');
        if (!options?.sitekey) throw new Error('Missing Turnstile sitekey');
        const id = 'emulate-turnstile-' + (++sequence), input = document.createElement('input');
        input.type = 'hidden'; input.name = options['response-field-name'] || 'cf-turnstile-response';
        if (options['response-field'] !== false) host.appendChild(input);
        const widget = {host, input, options, token:'', expired:false};
        widgets.set(id, widget); mount(widget); return id;
      },
      getResponse(target) { return resolve(target)?.token || ''; },
      isExpired(target) { return resolve(target)?.expired || false; },
      reset(target) { const widget = resolve(target); if (widget) mount(widget); },
      remove(target) {
        const widget = resolve(target); if (!widget) return;
        clearTimeout(widget.timer); widget.frame.remove(); widget.input.remove();
        for (const [id, value] of widgets) if (value === widget) widgets.delete(id);
      }
    };
    const onload = new URL(document.currentScript.src).searchParams.get('onload');
    if (onload && typeof window[onload] === 'function') queueMicrotask(window[onload]);
  })();`,
      200,
      { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
    ),
  );
  app.get("/turnstile/v0/widget", (c) => {
    let config: { origin: string; sitekey: string; action?: string; cData?: string };
    try {
      config = JSON.parse(c.req.query("config") ?? "");
      const origin = new URL(config.origin);
      if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== config.origin) throw new Error();
    } catch {
      return c.text("A parent origin is required", 400);
    }
    const configJSON = JSON.stringify(config).replace(/</g, "\\u003c");
    return c.html(
      renderWidgetPage(
        "Turnstile",
        `
      <p id="result" role="status">Verifying...</p>
      <script>
        const config = ${configJSON};
        fetch('issue', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(config)})
          .then(async response => {
            const result = await response.json();
            if (!response.ok || !result.token) throw new Error();
            document.getElementById('result').textContent = 'Verification successful';
            parent.postMessage({emulate:'turnstile', token:result.token}, config.origin);
          }).catch(() => {
            document.getElementById('result').textContent = 'Verification failed';
            parent.postMessage({emulate:'turnstile', error:'emulator-error'}, config.origin);
          });
      </script>`,
      ),
    );
  });
}
