// ──────────────────────────────────────────────────────────
//  Wake-on-LAN helper.
//  Sends the classic magic packet: 6 bytes of 0xFF followed by
//  16 repetitions of the target MAC. Broadcast UDP on port 9
//  (discard protocol) — the BIOS/NIC picks it up without any
//  service listening. WOL only works if:
//    1. The Pearl (or whatever) has WOL enabled in BIOS.
//    2. The sender is on the same L2 broadcast domain (i.e.
//       same VLAN). Subnet-directed broadcast can cross subnets
//       but most switches drop it — LAN-only is realistic.
// ──────────────────────────────────────────────────────────
import dgram from 'node:dgram';
import { logger } from '../logger.js';

const log = logger.child({ svc: 'wol' });

function parseMac(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) throw new Error(`invalid MAC: ${mac}`);
  return Buffer.from(hex, 'hex');
}

export async function sendMagicPacket(
  mac: string,
  opts: { broadcast?: string; port?: number } = {},
): Promise<void> {
  const macBuf = parseMac(mac);
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) {
    macBuf.copy(packet, 6 + i * 6);
  }
  const broadcast = opts.broadcast ?? '255.255.255.255';
  const port = opts.port ?? 9;

  await new Promise<void>((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', (err) => { socket.close(); reject(err); });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, port, broadcast, (err) => {
        socket.close();
        if (err) return reject(err);
        resolve();
      });
    });
  });
  log.info({ mac, broadcast, port }, 'wol magic packet sent');
}
