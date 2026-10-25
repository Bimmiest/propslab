import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import { SAMPLE_CONFIGS } from '../sampleData';
import type { EventMetadata } from '../types';
import { parseConf } from '../parser/confParser';
import { getDirectiveSupport } from '../directiveSupport';
import { AT_FIXED_NOW } from './runCtx';

/**
 * The bundled samples are example configs users copy from, so a wrong field
 * mapping teaches a wrong mapping for a very common data source.
 */
describe('sampleData — Palo Alto byte columns (#76)', () => {
  const pan = SAMPLE_CONFIGS.find((s) => s.name === 'Palo Alto Firewall')!;
  const meta: EventMetadata = { index: 'main', host: 'fw01', source: '/var/log/pan', sourcetype: 'pan:traffic' };

  it('maps the PAN-OS Bytes / Bytes Sent / Bytes Received columns in order', () => {
    const { result } = runPipeline(pan.rawData, meta, pan.propsConf, pan.transformsConf, AT_FIXED_NOW);
    const first = result.events[0]!;
    // Row 1 columns after `action`: 120 (total), 80 (sent), 40 (received).
    expect(first.fields['bytes']).toBe('120');
    expect(first.fields['bytes_sent']).toBe('80');
    expect(first.fields['bytes_received']).toBe('40');
  });

  it("makes the sample's own EVAL-bytes_total agree with the total column", () => {
    const { result } = runPipeline(pan.rawData, meta, pan.propsConf, pan.transformsConf, AT_FIXED_NOW);
    for (const event of result.events) {
      expect(event.fields['bytes_total']).toBe(event.fields['bytes']);
    }
  });
});

/**
 * Each example is the first thing a new user runs, so it must load clean and
 * show what its description promises (#666). The examples are dated
 * 25 October 2026; the clock here is the day after, so a yearless syslog date
 * takes 2026 and nothing lands past MAX_DAYS_HENCE.
 */
describe('the bundled examples (#666)', () => {
  const now = Date.UTC(2026, 9, 26);
  const run = (s: (typeof SAMPLE_CONFIGS)[number]) =>
    runPipeline(s.rawData, s.metadata, s.propsConf, s.transformsConf, { perEventPipeline: false, now });
  const byName = (name: string) => {
    const sample = SAMPLE_CONFIGS.find((s) => s.name === name);
    if (!sample) throw new Error(`no example named ${name}`);
    return run(sample).result.events;
  };

  it('has a unique name for each, and a stanza for its own sourcetype', () => {
    expect(new Set(SAMPLE_CONFIGS.map((s) => s.name)).size).toBe(SAMPLE_CONFIGS.length);
    for (const s of SAMPLE_CONFIGS) {
      expect(
        parseConf(s.propsConf, 'props.conf').stanzas.map((st) => st.name),
        s.name,
      ).toContain(s.metadata.sourcetype);
    }
  });

  it.each(SAMPLE_CONFIGS.map((s) => [s.name, s] as const))('%s loads with no warning or error', (_name, s) => {
    const { result, diagnostics } = run(s);
    expect(diagnostics.filter((d) => d.level !== 'info')).toEqual([]);
    expect(result.eventCount).toBeGreaterThan(0);
    for (const event of result.events) expect(event._time?.getUTCFullYear()).toBe(2026);
  });

  it('uses only directives the engine simulates', () => {
    const unsimulated = SAMPLE_CONFIGS.flatMap((s) =>
      [parseConf(s.propsConf, 'props.conf'), parseConf(s.transformsConf, 'transforms.conf')]
        .flatMap((conf) => conf.stanzas.flatMap((st) => st.directives))
        .filter((d) => getDirectiveSupport(d.directiveType)?.support !== 'simulated')
        .map((d) => `${s.name}: ${d.key}`),
    );
    expect(unsimulated).toEqual([]);
  });

  it('uses only documentation (RFC 5737) and private addresses', () => {
    const allowed = [
      /^192\.0\.2\./,
      /^198\.51\.100\./,
      /^203\.0\.113\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^0\.0\.0\.0$/,
    ];
    const addresses = SAMPLE_CONFIGS.flatMap((s) => s.rawData.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []);
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.filter((a) => !allowed.some((re) => re.test(a)))).toEqual([]);
  });

  it('shows what each description promises', () => {
    const apache = byName('Apache Access Log');
    expect(apache[1]?.fields).toMatchObject({ user: 'anonymous', action: 'failure', uri_path: '/login' });
    expect(apache[2]?.fields['uri_query']).toBe('view=week');

    const ssh = byName('Linux SSH Auth');
    expect(ssh[1]?.fields).toMatchObject({ user: 'admin', action: 'failure', src: '203.0.113.77', app: 'sshd' });
    expect(ssh[3]?.fields).toMatchObject({ src_user: 'deploy', user: 'root' });

    const windows = byName('Windows Security (XML)');
    expect(windows[0]?.fields).toMatchObject({ user: 'alice', action: 'success', app: 'win:remote' });
    expect(windows[0]?.fields['Data_Name']).toHaveLength(5);

    const cloudtrail = byName('AWS CloudTrail (JSON)');
    expect(cloudtrail[0]?._time?.toISOString()).toBe('2026-10-25T08:31:05.000Z');
    expect(cloudtrail.map((e) => e.fields['action'])).toEqual(['success', 'failure']);
    expect(cloudtrail[0]?.fields['user']).toBe('carol');

    const asa = byName('Cisco ASA');
    expect(asa[1]?.fields).toMatchObject({
      message_id: '106023',
      action: 'blocked',
      dest_port: '22',
      rule: 'outside_in',
    });
    expect(asa[2]?.fields).toMatchObject({ vendor_action: 'Teardown', bytes: '5821', transport: 'tcp' });

    const java = byName('Java App (Multi-line)');
    expect(java).toHaveLength(3);
    expect(java[1]?._raw).toContain('at com.example.orders.OrderService.place');
    expect(java[1]?.fields).toMatchObject({ level: 'ERROR', exception_class: 'java.net.SocketTimeoutException' });

    const csv = byName('CSV Export');
    expect(csv[0]?.fields).toMatchObject({ user: 'alice', src: '198.51.100.31', bytes: '1310720' });

    const fortigate = byName('FortiGate Traffic');
    expect(fortigate.map((e) => e.fields['action'])).toEqual(['allowed', 'blocked']);
    expect(fortigate[0]?.fields).toMatchObject({ transport: 'tcp', bytes: '23230', dest_port: '443' });
  });
});
