export const clashYaml = `mixed-port: 7890
proxies:
  - name: Hong Kong Premium
    type: ss
    server: hk.example.invalid
    port: 443
    cipher: aes-128-gcm
    password: fake-password
    udp: true
  - name: Tokyo 2
    type: trojan
    server: jp.example.invalid
    port: 443
    password: fake-password
    tls: true
    sni: edge.example.invalid
    network: ws
    ws-opts:
      path: /fake-path
  - name: 🇬🇧 London
    type: vless
    server: uk.example.invalid
    port: 8443
    uuid: fake-uuid-value
    client-fingerprint: chrome
    reality-opts:
      public-key: fake-public-key
`;
