export interface SampleConfig {
  name: string;
  /** The kind of data source, which groups the examples in the library. */
  category: string;
  description: string;
  rawData: string;
  propsConf: string;
  transformsConf: string;
  metadata: { index: string; host: string; source: string; sourcetype: string };
}

// The examples a user loads from the empty preview and the command palette
// (#666). Each shows a different part of the pipeline. Every host, user and
// address is invented: the addresses are RFC 5737 documentation ranges or
// private ranges, and the domains are example.com. Every config is written
// from the .spec files, not copied from an add-on. The dates are in 2026, so
// they stay inside the default MAX_DAYS_AGO (2000 days) of the real clock
// until 2032.
export const SAMPLE_CONFIGS: SampleConfig[] = [
  {
    name: 'Apache Access Log',
    category: 'Web',
    description: 'Field extraction from Apache combined log format with EVAL enrichment',
    metadata: {
      index: 'web',
      host: 'web-prod-01',
      source: '/var/log/apache2/access.log',
      sourcetype: 'access_combined',
    },
    rawData: `198.51.100.10 - frank [25/Oct/2026:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326
198.51.100.20 - - [25/Oct/2026:13:55:37 -0700] "POST /login HTTP/1.1" 403 512
203.0.113.30 - admin [25/Oct/2026:13:55:38 -0700] "GET /admin/dashboard?view=week HTTP/1.0" 200 1024
203.0.113.40 - - [25/Oct/2026:13:55:39 -0700] "GET /nonexistent HTTP/1.1" 404 209
192.0.2.50 - jdoe [25/Oct/2026:13:55:40 -0700] "DELETE /api/v1/record/42 HTTP/1.1" 204 0`,
    propsConf: `[access_combined]
TIME_PREFIX = \\[
TIME_FORMAT = %d/%b/%Y:%H:%M:%S %z
MAX_TIMESTAMP_LOOKAHEAD = 28
SHOULD_LINEMERGE = false
KV_MODE = none

EXTRACT-fields = ^(?P<clientip>\\S+) \\S+ (?P<user>\\S+) \\[(?P<timestamp>[^\\]]+)\\] "(?P<method>\\w+) (?P<uri>\\S+) (?P<http_version>[^"]+)" (?P<status>\\d+) (?P<bytes>\\d+)

REPORT-uri_parts = uri_path_extract

FIELDALIAS-cim = clientip AS src method AS http_method uri AS url bytes AS bytes_out host AS dest
EVAL-vendor_product = "Apache HTTP Server"
EVAL-user = if(user=="-", "anonymous", user)
EVAL-action = if(status < 400, "success", "failure")
EVAL-category = case(status < 300, "success", status < 400, "redirect", status < 500, "client_error", true(), "server_error")`,
    transformsConf: `[uri_path_extract]
SOURCE_KEY = uri
REGEX = ^(?P<uri_path>[^?#]+)(?:\\?(?P<uri_query>[^#]*))?`,
  },
  {
    name: 'Palo Alto Firewall',
    category: 'Network',
    description: 'Palo Alto TRAFFIC log parsing with REGEX extraction, field aliases and EVAL enrichment',
    metadata: {
      index: 'network',
      host: 'pa-fw-01',
      source: 'syslog',
      sourcetype: 'pan:traffic',
    },
    rawData: `1,2026/10/25 14:23:01,007051000012345,TRAFFIC,end,2561,2026/10/25 14:23:01,10.0.1.5,198.51.100.53,0.0.0.0,0.0.0.0,allow-internet,,,dns,vsys1,trust,untrust,ethernet1/1,ethernet1/2,default-logging,2026/10/25 14:23:01,12345,1,54321,53,0,0,0x0,udp,allow,120,80,40,1,2026/10/25 14:23:00,0,any,0,1234567890,0x0,United States,10.0.0.0-10.255.255.255,0,1,0
1,2026/10/25 14:23:05,007051000012345,TRAFFIC,end,2561,2026/10/25 14:23:05,10.0.1.10,203.0.113.80,0.0.0.0,0.0.0.0,allow-internet,,,web-browsing,vsys1,trust,untrust,ethernet1/1,ethernet1/2,default-logging,2026/10/25 14:23:05,54321,1,45678,443,0,0,0x0,tcp,allow,4096,2048,2048,3,2026/10/25 14:23:02,0,any,0,9876543210,0x0,United States,10.0.0.0-10.255.255.255,0,3,2`,
    propsConf: `[pan:traffic]
SHOULD_LINEMERGE = false
KV_MODE = none

REPORT-pan_traffic = pan_traffic_fields

FIELDALIAS-src       = src_ip AS src
FIELDALIAS-dest      = dest_ip AS dest
FIELDALIAS-transport = proto AS transport
FIELDALIAS-cim       = sport AS src_port dport AS dest_port bytes_sent AS bytes_out bytes_received AS bytes_in rulename AS rule host AS dvc

EVAL-action      = if(action=="allow", "allowed", "blocked")
EVAL-bytes_total = bytes_sent + bytes_received
EVAL-vendor_product = "Palo Alto Networks Firewall"`,
    transformsConf: `[pan_traffic_fields]
REGEX = ^[^,]+,(?P<receive_time>[^,]+),[^,]+,(?P<type>[^,]+),(?P<subtype>[^,]+),[^,]+,[^,]+,(?P<src_ip>[^,]+),(?P<dest_ip>[^,]+),[^,]+,[^,]+,(?P<rulename>[^,]+),[^,]*,[^,]*,(?P<app>[^,]+),[^,]+,(?P<from_zone>[^,]+),(?P<to_zone>[^,]+),[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,[^,]+,(?P<sport>[^,]+),(?P<dport>[^,]+),[^,]+,[^,]+,[^,]+,(?P<proto>[^,]+),(?P<action>[^,]+),(?P<bytes>[^,]+),(?P<bytes_sent>[^,]+),(?P<bytes_received>[^,]+)`,
  },
  {
    name: 'Linux SSH Auth',
    category: 'Operating system',
    description: 'Syslog with no year in the timestamp, EXTRACT and EVAL for the CIM Authentication model',
    metadata: {
      index: 'os',
      host: 'bastion-01',
      source: '/var/log/secure',
      sourcetype: 'linux_secure',
    },
    rawData: `Oct 25 08:12:01 bastion-01 sshd[2214]: Accepted publickey for deploy from 198.51.100.24 port 52814 ssh2
Oct 25 08:12:44 bastion-01 sshd[2231]: Failed password for invalid user admin from 203.0.113.77 port 40122 ssh2
Oct 25 08:12:47 bastion-01 sshd[2231]: Failed password for root from 203.0.113.77 port 40130 ssh2
Oct 25 08:13:02 bastion-01 sudo:   deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/systemctl restart nginx
Oct 25 08:15:10 bastion-01 sshd[2214]: pam_unix(sshd:session): session closed for user deploy`,
    propsConf: `[linux_secure]
SHOULD_LINEMERGE = false
TIME_PREFIX = ^
TIME_FORMAT = %b %d %H:%M:%S
MAX_TIMESTAMP_LOOKAHEAD = 15
TZ = UTC
KV_MODE = none

EXTRACT-header = ^\\w{3} +\\d+ [\\d:]+ (?<dest>\\S+) (?<app>[\\w-]+)
EXTRACT-sshd = sshd\\[\\d+\\]: (?<status>Accepted|Failed) (?<authentication_method>\\S+) for (?:invalid user )?(?<user>\\S+) from (?<src>\\S+) port (?<src_port>\\d+)
EXTRACT-sudo = sudo: +(?<src_user>\\S+) : .*?USER=(?<user>\\S+) ; COMMAND=(?<command>.+)$

EVAL-action = case(status=="Accepted", "success", status=="Failed", "failure")`,
    transformsConf: ``,
  },
  {
    name: 'Windows Security (XML)',
    category: 'Operating system',
    description:
      'Windows event log XML read with KV_MODE = xml: each named Data element is a field, and Data_Name is multivalue',
    metadata: {
      index: 'wineventlog',
      host: 'dc01',
      source: 'XmlWinEventLog:Security',
      sourcetype: 'XmlWinEventLog:Security',
    },
    rawData: `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing'/><EventID>4624</EventID><Level>0</Level><Task>12544</Task><Keywords>0x8020000000000000</Keywords><TimeCreated SystemTime='2026-10-25T08:20:11.1234567Z'/><EventRecordID>88213</EventRecordID><Channel>Security</Channel><Computer>dc01.corp.example.com</Computer></System><EventData><Data Name='TargetUserName'>alice</Data><Data Name='TargetDomainName'>CORP</Data><Data Name='LogonType'>3</Data><Data Name='IpAddress'>198.51.100.12</Data><Data Name='WorkstationName'>WKS-0042</Data></EventData></Event>
<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Security-Auditing'/><EventID>4625</EventID><Level>0</Level><Task>12544</Task><Keywords>0x8010000000000000</Keywords><TimeCreated SystemTime='2026-10-25T08:20:19.5551234Z'/><EventRecordID>88214</EventRecordID><Channel>Security</Channel><Computer>dc01.corp.example.com</Computer></System><EventData><Data Name='TargetUserName'>bob</Data><Data Name='TargetDomainName'>CORP</Data><Data Name='LogonType'>3</Data><Data Name='IpAddress'>203.0.113.91</Data><Data Name='WorkstationName'>-</Data><Data Name='FailureReason'>%%2313</Data></EventData></Event>`,
    propsConf: `[XmlWinEventLog:Security]
SHOULD_LINEMERGE = false
TIME_PREFIX = <TimeCreated SystemTime='
TIME_FORMAT = %Y-%m-%dT%H:%M:%S.%7N%z
MAX_TIMESTAMP_LOOKAHEAD = 30
KV_MODE = xml

FIELDALIAS-cim = TargetUserName AS user IpAddress AS src 'Event.System.Computer' AS dest
EVAL-action = case('Event.System.EventID'=="4624", "success", 'Event.System.EventID'=="4625", "failure")
EVAL-app = if(LogonType=="3", "win:remote", "win:local")`,
    transformsConf: ``,
  },
  {
    name: 'AWS CloudTrail (JSON)',
    category: 'Cloud',
    description: 'JSON events read at index time with INDEXED_EXTRACTIONS = json, the timestamp from TIMESTAMP_FIELDS',
    metadata: {
      index: 'aws',
      host: 'cloudtrail',
      source: 's3://example-trail/AWSLogs/123456789012/CloudTrail/',
      sourcetype: 'aws:cloudtrail',
    },
    rawData: `{"eventVersion":"1.10","eventTime":"2026-10-25T08:31:05Z","eventSource":"signin.amazonaws.com","eventName":"ConsoleLogin","awsRegion":"eu-west-1","sourceIPAddress":"198.51.100.40","userIdentity":{"type":"IAMUser","userName":"carol","accountId":"123456789012"},"responseElements":{"ConsoleLogin":"Success"},"additionalEventData":{"MFAUsed":"Yes"}}
{"eventVersion":"1.10","eventTime":"2026-10-25T08:31:42Z","eventSource":"s3.amazonaws.com","eventName":"PutBucketPolicy","awsRegion":"eu-west-1","sourceIPAddress":"198.51.100.40","userIdentity":{"type":"IAMUser","userName":"carol","accountId":"123456789012"},"requestParameters":{"bucketName":"example-reports"},"errorCode":"AccessDenied"}`,
    propsConf: `[aws:cloudtrail]
SHOULD_LINEMERGE = false
INDEXED_EXTRACTIONS = json
TIMESTAMP_FIELDS = eventTime
TIME_FORMAT = %Y-%m-%dT%H:%M:%S%z
KV_MODE = none
AUTO_KV_JSON = false

FIELDALIAS-src = sourceIPAddress AS src
FIELDALIAS-user = 'userIdentity.userName' AS user
EVAL-action = if(isnull(errorCode), "success", "failure")`,
    transformsConf: ``,
  },
  {
    name: 'Cisco ASA',
    category: 'Network',
    description: 'REPORT transforms keyed on the ASA message ID, with aliases for the CIM Network Traffic model',
    metadata: {
      index: 'network',
      host: 'asa-edge-01',
      source: 'udp:514',
      sourcetype: 'cisco:asa',
    },
    rawData: `Oct 25 2026 08:30:01 asa-edge-01 : %ASA-6-302013: Built inbound TCP connection 410233 for outside:203.0.113.50/51733 (203.0.113.50/51733) to inside:10.10.20.15/443 (198.51.100.15/443)
Oct 25 2026 08:30:02 asa-edge-01 : %ASA-4-106023: Deny tcp src outside:192.0.2.66/41020 dst inside:10.10.20.30/22 by access-group "outside_in" [0x0, 0x0]
Oct 25 2026 08:30:05 asa-edge-01 : %ASA-6-302014: Teardown TCP connection 410233 for outside:203.0.113.50/51733 to inside:10.10.20.15/443 duration 0:00:04 bytes 5821 TCP FINs`,
    propsConf: `[cisco:asa]
SHOULD_LINEMERGE = false
TIME_PREFIX = ^
TIME_FORMAT = %b %d %Y %H:%M:%S
MAX_TIMESTAMP_LOOKAHEAD = 20
TZ = UTC
KV_MODE = none

REPORT-asa = asa_message_id, asa_connection, asa_deny

FIELDALIAS-cim = src_ip AS src dest_ip AS dest host AS dvc
EVAL-transport = lower(transport)
EVAL-vendor_product = "Cisco ASA"
EVAL-action = case(message_id=="106023", "blocked", message_id=="302013" OR message_id=="302014", "allowed")`,
    transformsConf: `[asa_message_id]
REGEX = %ASA-(?<severity>\\d)-(?<message_id>\\d{6}):

[asa_connection]
REGEX = (?<vendor_action>Built|Teardown) (?:(?<direction>inbound|outbound) )?(?<transport>TCP|UDP) connection (?<session_id>\\d+) for (?<src_zone>[^:]+):(?<src_ip>[^/]+)/(?<src_port>\\d+).*? to (?<dest_zone>[^:]+):(?<dest_ip>[^/]+)/(?<dest_port>\\d+)(?:.*? bytes (?<bytes>\\d+))?

[asa_deny]
REGEX = Deny (?<transport>\\w+) src (?<src_zone>[^:]+):(?<src_ip>[^/]+)/(?<src_port>\\d+) dst (?<dest_zone>[^:]+):(?<dest_ip>[^/]+)/(?<dest_port>\\d+) by access-group "(?<rule>[^"]+)"`,
  },
  {
    name: 'Java App (Multi-line)',
    category: 'Application',
    description: 'Stack traces kept with their event: a LINE_BREAKER with a lookahead, and no line merging',
    metadata: {
      index: 'app',
      host: 'orders-01',
      source: '/opt/orders/logs/app.log',
      sourcetype: 'java:app',
    },
    rawData: `2026-10-25 08:40:12,401 INFO  [main] com.example.orders.OrderService - Order 1042 accepted for customer c-7781
2026-10-25 08:40:13,017 ERROR [http-nio-8080-exec-3] com.example.orders.PaymentClient - Payment call failed
java.net.SocketTimeoutException: Read timed out
	at java.base/java.net.SocketInputStream.socketRead0(Native Method)
	at com.example.orders.PaymentClient.charge(PaymentClient.java:88)
	at com.example.orders.OrderService.place(OrderService.java:51)
2026-10-25 08:40:13,020 WARN  [http-nio-8080-exec-3] com.example.orders.OrderService - Order 1043 held for retry`,
    propsConf: `[java:app]
SHOULD_LINEMERGE = false
LINE_BREAKER = ([\\r\\n]+)(?=\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2},\\d{3} )
TIME_PREFIX = ^
TIME_FORMAT = %Y-%m-%d %H:%M:%S,%3N
MAX_TIMESTAMP_LOOKAHEAD = 23
TZ = UTC
KV_MODE = none

EXTRACT-header = ^\\S+ \\S+ (?<level>[A-Z]+) +\\[(?<thread>[^\\]]+)\\] (?<logger>\\S+) - (?<message>[^\\r\\n]*)
EXTRACT-exception = [\\r\\n](?<exception_class>[\\w.$]+(?:Exception|Error)): (?<exception_message>[^\\r\\n]*)`,
    transformsConf: ``,
  },
  {
    name: 'CSV Export',
    category: 'File',
    description: 'A CSV file with no header row, its columns named by FIELD_NAMES at index time',
    metadata: {
      index: 'vpn',
      host: 'vpn-gw-01',
      source: '/exports/vpn_sessions.csv',
      sourcetype: 'vpn:sessions:csv',
    },
    rawData: `2026-10-25T07:58:00Z,alice,198.51.100.31,NL,1048576,262144,connected
2026-10-25T08:02:14Z,bob,203.0.113.18,DE,52428,8192,disconnected
2026-10-25T08:05:47Z,carol,192.0.2.140,GB,3145728,524288,connected`,
    propsConf: `[vpn:sessions:csv]
INDEXED_EXTRACTIONS = csv
FIELD_NAMES = timestamp,user,src_ip,country,bytes_in,bytes_out,status
TIMESTAMP_FIELDS = timestamp
TIME_FORMAT = %Y-%m-%dT%H:%M:%S%z
KV_MODE = none

FIELDALIAS-src = src_ip AS src
EVAL-bytes = bytes_in + bytes_out`,
    transformsConf: ``,
  },
  {
    name: 'FortiGate Traffic',
    category: 'Network',
    description: 'key=value pairs read by KV_MODE = auto, with aliases and EVAL for the CIM Network Traffic model',
    metadata: {
      index: 'network',
      host: 'fgt-branch-01',
      source: 'udp:514',
      sourcetype: 'fgt_traffic',
    },
    rawData: `date=2026-10-25 time=08:50:03 devname="fgt-branch-01" devid="FGT60F0000000001" logid="0000000013" type="traffic" subtype="forward" level="notice" vd="root" srcip=10.20.1.15 srcport=51544 srcintf="internal" dstip=203.0.113.10 dstport=443 dstintf="wan1" proto=6 action="accept" policyid=12 service="HTTPS" duration=32 sentbyte=4410 rcvdbyte=18820 app="HTTPS.BROWSER"
date=2026-10-25 time=08:50:09 devname="fgt-branch-01" devid="FGT60F0000000001" logid="0000000013" type="traffic" subtype="forward" level="warning" vd="root" srcip=10.20.1.44 srcport=60211 srcintf="internal" dstip=192.0.2.200 dstport=3389 dstintf="wan1" proto=6 action="deny" policyid=0 service="RDP" duration=0 sentbyte=0 rcvdbyte=0`,
    propsConf: `[fgt_traffic]
SHOULD_LINEMERGE = false
TIME_PREFIX = ^date=
TIME_FORMAT = %Y-%m-%d time=%H:%M:%S
MAX_TIMESTAMP_LOOKAHEAD = 25
TZ = UTC
KV_MODE = auto

FIELDALIAS-cim = srcip AS src dstip AS dest srcport AS src_port dstport AS dest_port sentbyte AS bytes_out rcvdbyte AS bytes_in policyid AS rule devname AS dvc
EVAL-transport = case(proto=="6", "tcp", proto=="17", "udp", proto=="1", "icmp")
EVAL-action = if(action=="accept", "allowed", "blocked")
EVAL-bytes = sentbyte + rcvdbyte
EVAL-vendor_product = "Fortinet FortiGate"`,
    transformsConf: ``,
  },
];
