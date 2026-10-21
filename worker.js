// 《遠征》四人連線中繼伺服器（Cloudflare Worker + Durable Object）
// 每個房號對應一個 Room；房主（P1）執行遊戲運算，畫面與事件經由這裡轉送給 P2～P4。
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{1,12})$/);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('需要 WebSocket 連線', { status: 426 });
      const id = env.ROOMS.idFromName(m[1].toUpperCase());
      return env.ROOMS.get(id).fetch(req);
    }
    return new Response('遠征連線伺服器運作中', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
};

const GUEST_SEATS = ['p2', 'p3', 'p4'];

export class Room {
  constructor(state, env) {
    this.state = state;
    this.clients = new Map();   // ws -> { seat, name }
    this.snap = null;           // 最新畫面（給中途加入的人）
    this.dict = {};             // 畫面中所有圖像
  }

  async fetch(req) {
    const url = new URL(req.url);
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'guest';
    const name = (url.searchParams.get('name') || '').slice(0, 12);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    let seat;
    if (role === 'host') {
      for (const [ws, c] of this.clients) {
        if (c.seat === 'p1') { this.clients.delete(ws); try { ws.close(4001, '房主已在別處連線'); } catch (e) {} }
      }
      seat = 'p1';
      this.snap = null;
      this.dict = {};
    } else {
      const used = new Set([...this.clients.values()].map(c => c.seat));
      seat = GUEST_SEATS.find(s => !used.has(s));
      if (!seat) {
        server.send(JSON.stringify({ t: 'full' }));
        server.close(4002, '房間已滿');
        return new Response(null, { status: 101, webSocket: client });
      }
    }

    this.clients.set(server, { seat, name });
    this.send(server, { t: 'welcome', seat });
    if (seat !== 'p1' && this.snap) this.send(server, { t: 'snap', ...this.snap, dict: this.dict });
    this.broadcastSeats();

    server.addEventListener('message', e => this.onMessage(server, e.data));
    const bye = () => {
      if (this.clients.has(server)) { this.clients.delete(server); this.broadcastSeats(); }
    };
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws, data) {
    const me = this.clients.get(ws);
    if (!me) return;
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (msg.t === 'ping') { this.send(ws, { t: 'pong', ts: msg.ts }); return; }

    if (me.seat === 'p1') {
      if (msg.t === 'snap') {
        Object.assign(this.dict, msg.dict || {});
        this.snap = { html: msg.html, cls: msg.cls, canv: msg.canv, st: msg.st };
        this.toGuests(data);
      } else if (msg.t === 'to') {
        for (const [w, c] of this.clients) if (c.seat === msg.seat) this.send(w, msg.msg);
      } else {
        this.toGuests(data);
      }
    } else {
      for (const [w, c] of this.clients) {
        if (c.seat === 'p1') this.send(w, { t: 'from', seat: me.seat, name: me.name, msg });
      }
    }
  }

  toGuests(raw) {
    for (const [w, c] of this.clients) if (c.seat !== 'p1') { try { w.send(raw); } catch (e) {} }
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }

  broadcastSeats() {
    const seats = { p1: null, p2: null, p3: null, p4: null };
    for (const c of this.clients.values()) seats[c.seat] = c.name || c.seat.toUpperCase();
    for (const w of this.clients.keys()) this.send(w, { t: 'seats', seats });
  }
}
