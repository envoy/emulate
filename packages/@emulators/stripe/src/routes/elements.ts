import { renderCardPage, type RouteContext } from "@emulators/core";

// The browser shim only implements Elements card entry and createToken. The
// iframe validates message source and origin and sends card data only to this emulator.
export function elementsRoutes({ app }: RouteContext): void {
  app.get("/stripe.js", (c) =>
    c.text(
      String.raw`(function () {
  const base = new URL('.', document.currentScript.src).href;
  function Stripe(key) {
    if (!(this instanceof Stripe)) return new Stripe(key);
    if (!/^pk_test_/.test(key)) throw new Error('Emulated Stripe requires a test publishable key');
    this.elements = function () { return { create: function (type) {
      if (type !== 'card') throw new Error('Only the card Element is supported');
      const listeners = new Map(), pending = new Map();
      let frame;
      function emit(name, data) { for (const callback of listeners.get(name) || []) callback(data); }
      function receive(event) {
        if (!frame || event.source !== frame.contentWindow || event.origin !== new URL(base).origin) return;
        const message = event.data;
        if (message?.emulate !== 'stripe-card') return;
        if (message.event === 'token') { const callback = pending.get(message.id); if (callback) { pending.delete(message.id); callback(message.result); } }
        else emit(message.event, message.data);
      }
      window.addEventListener('message', receive);
      const element = {
        mount(target) {
          if (frame) throw new Error('Element already mounted');
          const host = typeof target === 'string' ? document.querySelector(target) : target;
          if (!host) throw new Error('Missing mount target');
          frame = document.createElement('iframe'); frame.title = 'Secure card payment input';
          frame.src = base + 'elements/card?parent=' + encodeURIComponent(location.origin);
          frame.height = '310'; frame.width = '100%'; frame.setAttribute('frameborder', '0'); host.appendChild(frame);
        },
        on(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); return this; },
        off(name, callback) { listeners.set(name, (listeners.get(name) || []).filter(fn => fn !== callback)); return this; },
        update() {},
        focus() { frame?.contentWindow.postMessage({ emulate: 'stripe-card', event: 'focus' }, new URL(base).origin); },
        clear() { frame?.contentWindow.postMessage({ emulate: 'stripe-card', event: 'clear' }, new URL(base).origin); },
        unmount() { frame?.remove(); frame = undefined; },
        destroy() { this.unmount(); window.removeEventListener('message', receive); for (const callback of pending.values()) callback({error:{message:'Element destroyed'}}); pending.clear(); },
        _token(options) {
          if (!frame) return Promise.resolve({ error: { message: 'Element is not mounted' } });
          return new Promise(resolve => { const id = crypto.randomUUID(); pending.set(id, resolve);
            frame.contentWindow.postMessage({ emulate: 'stripe-card', event: 'token', id, key, options }, new URL(base).origin);
            setTimeout(() => { if (pending.delete(id)) resolve({ error: { message: 'Token request timed out' } }); }, 15000);
          });
        }
      }; return element;
    } }; };
    this.createToken = function (element, options) { return element._token(options || {}); };
  }
  window.Stripe = Stripe;
})();`,
      200,
      { "Content-Type": "application/javascript; charset=utf-8" },
    ),
  );
  app.get("/elements/card", (c) => {
    let parent: string;
    try {
      const url = new URL(c.req.query("parent") ?? "");
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== c.req.query("parent")) throw new Error();
      parent = url.origin;
    } catch {
      return c.text("A parent origin is required", 400);
    }
    const parentJSON = JSON.stringify(parent).replace(/</g, "\\u003c");
    return c.html(
      renderCardPage(
        "Test card",
        "Emulated payment details",
        `
      <label>Card number<input id="number" placeholder="Card number" autocomplete="off" inputmode="numeric"></label>
      <label>Expiry<input id="expiry" placeholder="MM / YY" autocomplete="off"></label>
      <label>CVC<input id="cvc" placeholder="CVC" autocomplete="off" inputmode="numeric"></label>
      <label>ZIP<input id="zip" placeholder="ZIP" autocomplete="off"></label>
      <script>
      const parentOrigin = ${parentJSON};
      const field = id => document.getElementById(id);
      const send = (event, data, extra = {}) => parent.postMessage({emulate:'stripe-card', event, data, ...extra}, parentOrigin);
      function changed() {
        const complete = /^\\d{16}$/.test(field('number').value.replace(/\\s/g,'')) && /^\\d{2}\\s*\\/\\s*\\d{2,4}$/.test(field('expiry').value) && /^\\d{3}$/.test(field('cvc').value) && field('zip').value.length > 0;
        send('change', {complete, empty: !field('number').value});
      }
      for (const input of document.querySelectorAll('input')) {
        input.addEventListener('input', changed);
        input.addEventListener('focus', () => send('focus', {}));
        input.addEventListener('blur', () => send('blur', {}));
      }
      window.addEventListener('message', async event => {
        if (event.source !== parent || event.origin !== parentOrigin || event.data?.emulate !== 'stripe-card') return;
        const message = event.data;
        if (message.event === 'focus') field('number').focus();
        if (message.event === 'clear') { for (const input of document.querySelectorAll('input')) input.value = ''; changed(); }
        if (message.event !== 'token') return;
        const expiry = field('expiry').value.split('/').map(s => s.trim());
        const card = {number:field('number').value, exp_month:expiry[0], exp_year:expiry[1]?.length === 2 ? '20'+expiry[1] : expiry[1], cvc:field('cvc').value, address_zip:field('zip').value, name:message.options?.name};
        try {
          const response = await fetch(new URL('../v1/tokens', location.href), {method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer '+message.key}, body:JSON.stringify({card})});
          const data = await response.json();
          send('token', {}, {id:message.id, result:response.ok ? {token:data} : data});
        } catch { send('token', {}, {id:message.id, result:{error:{message:'Emulator unavailable'}}}); }
      });
      send('ready', {});
      </script>`,
        "stripe",
      ),
    );
  });
}
