// The shape of a directive registry entry. Its own module so the data files
// under registry/ and the assembly in directiveRegistry.ts can share it without
// importing each other.

import type { DirectiveSupport } from '../directiveSupport';

export interface DirectiveInfo {
  key: string;
  description: string;
  example: string;
  defaultValue: string;
  category: string;
  appliesTo: 'props.conf' | 'transforms.conf' | 'both';
  valueType: 'regex' | 'string' | 'number' | 'boolean' | 'enum' | 'strftime' | 'eval';
  enumValues?: string[];
  isClassBased: boolean;
  phase: 'index-time' | 'search-time' | 'both';
  deprecated?: boolean;
  /**
   * What the simulator does with this directive, as opposed to what it knows
   * about it (#153). Attached from `directiveSupport.ts` rather than written on
   * each entry, so the whole boundary can be read in one place.
   */
  support: DirectiveSupport;
  /** Why it is not simulated, or the caveat on one that only partly is. */
  supportNote?: string;
  /** Tracking issue, for `ignored`. */
  supportIssue?: number;
}

/** The literal entries below, before support classification is attached. */
export type DirectiveDefinition = Omit<DirectiveInfo, 'support' | 'supportNote' | 'supportIssue'>;
