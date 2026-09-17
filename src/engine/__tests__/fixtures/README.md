# Fidelity fixtures

Each `splunk-<version>/` directory holds recorded output of a Splunk
Enterprise instance processing small synthetic inputs: one JSON file per case
in `corpus.ts`, plus a `manifest.json` naming the Splunk version and build and
the cases recorded. `splunkFidelity.test.ts` replays each case through the
engine and asserts it reproduces the recorded events and fields. These are the
only assertions in this repository derived from Splunk itself rather than from
its documentation, which is why they matter: several long-standing bugs were
reasonable readings of `props.conf.spec` that real Splunk contradicts.

## Provenance

The `splunk-10.4.0` set was recorded from Splunk Enterprise 10.4.0 (build in
the manifest) in August 2026. Each fixture holds functional results only — the
`props.conf` and `transforms.conf` stanzas that were loaded, the input line,
and the events and fields Splunk produced from it. No timing, throughput or
resource figures were recorded, and this project publishes no benchmark or
comparative evaluation of Splunk software.

Section 18.2 of the
[Splunk General Terms](https://www.splunk.com/en_us/legal/splunk-general-terms.html)
states that "you own any reporting results that you or your Third Party
Providers may derive from Customer Content through the use of the Offerings".
Each fixture is exactly that: Splunk's output over input lines this project
supplied. They are the property of the maintainer who recorded them.

## Why there is no capture script

There used to be one, with a guide that named Splunk Enterprise Free and the
`splunk/splunk` container as the instances to run it against. Both are
licensed under the Splunk General Terms — the 10.x container images require
accepting them at start-up — and section 1.2 of those terms, as last updated
in May 2026, reaches what the script did:

- **1.2(vii)** prohibits using an Offering "in order to analyze, test,
  characterize, inspect, or monitor its source code or underlying structures,
  ideas, protocols, or algorithms it contains or uses". Recording how a props
  stanza turns an input line into fields is a characterisation of behaviour on
  the strict reading of those words. There is an argument that observing the
  documented configuration surface is ordinary use rather than characterising
  algorithms, but it is an argument, not a settled point.
- **1.2(vi)** prohibits using an Offering "to develop, test, troubleshoot,
  support, or market any software or service that ... integrates,
  interoperates with, or constitutes an extension of any Offering and that you
  use or intend to use for a commercial purpose".

Neither the free edition nor the container entitles anyone to run such a
capture, and this project holds no licence that does. So the script and its
guide were removed rather than kept behind a warning, and **the fixtures are
not being re-captured**. They stay as regression pins for behaviour the
documentation gets wrong.

## Adding a case

New behaviour is asserted against the documentation, in an ordinary unit test,
with a comment saying so and an assertion kept narrow. When real Splunk
contradicts such a test, open an issue with the input, the stanza and what
Splunk produced; that is how a wrong reading gets corrected.

`corpus.ts` and this directory are closed to new cases unless a maintainer
holds a licence or written consent that permits a capture. If that happens,
the fixture format is the `Fixture` interface in `splunkFidelity.test.ts` and
the manifest shape is `manifest.json`. Do not rename a case: the fixture
filename is its id.
