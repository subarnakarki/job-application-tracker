import { BlockList, isIP } from 'node:net';

/**
 * Addresses a pasted link must never reach: anything that is not the public internet. Fetching a
 * link someone pastes is the classic SSRF hole (cloud metadata at 169.254.169.254, the database
 * on a private network, localhost services), so every resolved address is checked here.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the cloud metadata address
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and 255.255.255.255
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (could reach private IPv4 behind a gateway)
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** True only for a literal IP address on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  // IPv4 written inside IPv6 (::ffff:10.0.0.1, ::ffff:a00:1) is judged as the IPv4 it is.
  const mapped = /^::ffff:(?:0:)?(.+)$/i.exec(address);
  if (mapped?.[1]) {
    const inner = mapped[1];
    if (isIP(inner) === 4) return isPublicAddress(inner);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(inner);
    if (hex?.[1] && hex[2]) {
      const value = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return isPublicAddress([24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.'));
    }
    return false;
  }
  return !blocked.check(address, 'ipv6');
}
