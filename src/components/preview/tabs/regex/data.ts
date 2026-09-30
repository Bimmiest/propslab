/** The Regex tab's reference: common constructs and ready-made field patterns. */

export interface RegexDirective {
  pattern: string;
  description: string;
  example: string;
}

export interface RegexCategory {
  name: string;
  directives: RegexDirective[];
}

export const REGEX_REFERENCE: RegexCategory[] = [
  {
    name: 'Character Classes',
    directives: [
      { pattern: '\\d', description: 'Digit (0-9)', example: '\\d+' },
      { pattern: '\\w', description: 'Word character (a-z, A-Z, 0-9, _)', example: '\\w+' },
      { pattern: '\\s', description: 'Whitespace', example: '\\s+' },
      { pattern: '.', description: 'Any character except newline', example: '.*' },
      { pattern: '[...]', description: 'Character set', example: '[a-zA-Z]' },
      { pattern: '[^...]', description: 'Negated character set', example: '[^\\s]+' },
    ],
  },
  {
    name: 'Quantifiers',
    directives: [
      { pattern: '*', description: 'Zero or more', example: '\\d*' },
      { pattern: '+', description: 'One or more', example: '\\w+' },
      { pattern: '?', description: 'Zero or one', example: '\\d?' },
      { pattern: '{n}', description: 'Exactly n times', example: '\\d{4}' },
      { pattern: '{n,m}', description: 'Between n and m times', example: '\\d{1,3}' },
      { pattern: '*?', description: 'Zero or more (non-greedy)', example: '.*?' },
    ],
  },
  {
    name: 'Anchors & Groups',
    directives: [
      { pattern: '^', description: 'Start of string', example: '^ERROR' },
      { pattern: '$', description: 'End of string', example: 'done$' },
      { pattern: '\\b', description: 'Word boundary', example: '\\bhost\\b' },
      {
        pattern: '(?P<name>...)',
        description: 'Named capture group (Splunk)',
        example: '(?P<ip>\\d+\\.\\d+\\.\\d+\\.\\d+)',
      },
      { pattern: '(?:...)', description: 'Non-capturing group', example: '(?:ERROR|WARN)' },
      { pattern: '|', description: 'Alternation (or)', example: 'ERROR|WARN' },
    ],
  },
  {
    name: 'Common Field Patterns',
    directives: [
      { pattern: '(?P<ip>\\d+\\.\\d+\\.\\d+\\.\\d+)', description: 'IPv4 address', example: '192.168.1.1' },
      {
        pattern: '(?P<ip>(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4})',
        description: 'IPv6 address',
        example: '2001:0db8::1',
      },
      {
        pattern: '(?P<mac>(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2})',
        description: 'MAC address',
        example: '00:1A:2B:3C:4D:5E',
      },
      { pattern: '(?P<status>\\d{3})', description: 'HTTP status code', example: '200, 404, 500' },
      { pattern: '(?P<method>GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)', description: 'HTTP method', example: 'GET' },
      { pattern: '(?P<url>\\/[^\\s?#]*)', description: 'URL path', example: '/api/v1/users' },
      {
        pattern: '(?P<email>[\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,})',
        description: 'Email address',
        example: 'user@example.com',
      },
      { pattern: '(?P<port>\\d{1,5})', description: 'Port number', example: '8080' },
      { pattern: '(?P<duration>\\d+\\.?\\d*)(?:ms|s)', description: 'Duration with unit', example: '123ms, 1.5s' },
      { pattern: '(?P<bytes>\\d+)', description: 'Byte count', example: '1024' },
      { pattern: '(?P<user>[\\w.@-]+)', description: 'Username', example: 'john.doe' },
      {
        pattern: '(?P<level>DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)',
        description: 'Log level',
        example: 'ERROR',
      },
      { pattern: '(?P<pid>\\d+)', description: 'Process ID', example: '12345' },
      {
        pattern: '(?P<uuid>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
        description: 'UUID',
        example: '550e8400-e29b-41d4-a716-446655440000',
      },
    ],
  },
  {
    name: 'Key-Value & Delimited',
    directives: [
      { pattern: '(?P<key>\\w+)=(?P<value>[^\\s,]+)', description: 'key=value pair', example: 'user=admin status=200' },
      {
        pattern: '(?P<key>\\w+)="(?P<value>[^"]*)"',
        description: 'key="quoted value"',
        example: 'msg="login success"',
      },
      { pattern: '"(?P<field>[^"]*)"', description: 'Double-quoted field', example: '"some value"' },
      { pattern: '\\[(?P<field>[^\\]]+)\\]', description: 'Bracketed field', example: '[category]' },
    ],
  },
  {
    name: 'Full Log Examples',
    directives: [
      {
        pattern:
          '(?P<ip>\\S+)\\s+\\S+\\s+(?P<user>\\S+)\\s+\\[(?P<timestamp>[^\\]]+)\\]\\s+"(?P<method>\\w+)\\s+(?P<uri>\\S+)\\s+\\S+"\\s+(?P<status>\\d+)\\s+(?P<bytes>\\d+)',
        description: 'Apache/NCSA Combined Log',
        example: '10.0.0.1 - frank [10/Oct/2024:13:55:36] "GET /index.html HTTP/1.1" 200 2326',
      },
      {
        pattern:
          '(?P<timestamp>\\S+\\s+\\S+)\\s+(?P<host>\\S+)\\s+(?P<process>\\w+)\\[(?P<pid>\\d+)\\]:\\s+(?P<message>.+)',
        description: 'Syslog format',
        example: 'Oct 11 22:14:15 server sshd[1234]: message',
      },
      {
        pattern:
          '(?P<timestamp>[\\d-]+\\s+[\\d:,]+)\\s+(?P<level>\\w+)\\s+\\[(?P<thread>[^\\]]+)\\]\\s+(?P<class>[\\w.]+)\\s+-\\s+(?P<message>.+)',
        description: 'Log4j / Java logging',
        example: '2024-01-15 10:30:45,123 ERROR [main] c.e.App - Something failed',
      },
      {
        pattern:
          '(?P<timestamp>[\\d/]+\\s+[\\d:]+)\\s+(?P<src_ip>\\S+)\\s+(?P<method>\\w+)\\s+(?P<uri>\\S+)\\s+(?P<src_port>\\d+)\\s+\\S+\\s+\\S+\\s+(?P<user_agent>\\S+)\\s+\\S+\\s+(?P<status>\\d+)',
        description: 'IIS W3C Log',
        example: '2024-01-15 10:30:45 10.0.0.1 GET /page 443 - Mozilla/5.0 - 200',
      },
      {
        pattern:
          '(?P<action>\\w+)\\s+(?P<src_ip>[\\d.]+):(?P<src_port>\\d+)\\s+->\\s+(?P<dest_ip>[\\d.]+):(?P<dest_port>\\d+)',
        description: 'Firewall connection log',
        example: 'ALLOW 10.0.0.1:5432 -> 10.0.0.2:443',
      },
    ],
  },
];

/** Categories that contain full patterns meant to replace the input rather than append */
export const REPLACE_CATEGORIES = new Set(['Common Field Patterns', 'Key-Value & Delimited', 'Full Log Examples']);
