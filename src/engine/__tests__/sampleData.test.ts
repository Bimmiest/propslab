import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import { SAMPLE_CONFIGS } from '../sampleData';
import type { EventMetadata } from '../types';

/**
 * The bundled samples are example configs users copy from, so a wrong field
 * mapping teaches a wrong mapping for a very common data source.
 */
describe('sampleData — Palo Alto byte columns (#76)', () => {
  const pan = SAMPLE_CONFIGS.find((s) => s.name === 'Palo Alto Firewall')!;
  const meta: EventMetadata = { index: 'main', host: 'fw01', source: '/var/log/pan', sourcetype: 'pan:traffic' };

  it('maps the PAN-OS Bytes / Bytes Sent / Bytes Received columns in order', () => {
    const { result } = runPipeline(pan.rawData, meta, pan.propsConf, pan.transformsConf);
    const first = result.events[0]!;
    // Row 1 columns after `action`: 120 (total), 80 (sent), 40 (received).
    expect(first.fields['bytes']).toBe('120');
    expect(first.fields['bytes_sent']).toBe('80');
    expect(first.fields['bytes_received']).toBe('40');
  });

  it("makes the sample's own EVAL-bytes_total agree with the total column", () => {
    const { result } = runPipeline(pan.rawData, meta, pan.propsConf, pan.transformsConf);
    for (const event of result.events) {
      expect(event.fields['bytes_total']).toBe(event.fields['bytes']);
    }
  });
});
