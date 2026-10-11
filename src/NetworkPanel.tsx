import { useState } from 'react';
import { Globe2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { NetworkConfig, NetworkState } from './types';

export default function NetworkPanel({ network, onConfigure, onView, onRestore }: {
  network: NetworkState;
  onConfigure: (config: NetworkConfig) => Promise<void>;
  onView: (peerId: string, sessionId: string) => void;
  onRestore: (peerId: string, sessionId: string) => Promise<void>;
}) {
  const [config, setConfig] = useState(network.config);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const update = (patch: Partial<NetworkConfig>) => setConfig((previous) => ({ ...previous, ...patch }));
  return <section className="network-panel">
    <div className="network-settings">
      <h2>This instance</h2>
      <p>Track tabs on several machines at once. A client waits for another instance to resume a session using the data saved on that client machine.</p>
      <div className="network-fields">
        <label>Instance name<input className="form-input" value={config.name} onChange={(event) => update({ name: event.target.value })}/></label>
        <label>Mode<select className="form-input" value={config.mode} onChange={(event) => update({ mode: event.target.value as NetworkConfig['mode'] })}><option value="off">Off — local only</option><option value="host">Host — share and monitor</option><option value="client">Client — wait for restore requests</option></select></label>
        <label>Listen port<input className="form-input" type="number" min="1" max="65535" value={config.port} onChange={(event) => update({ port: Number(event.target.value) })}/></label>
        <label>Connection token<span className="network-token"><input className="form-input" type={showToken ? 'text' : 'password'} autoComplete="off" value={config.token} onChange={(event) => update({ token: event.target.value })}/><button className="button secondary" type="button" aria-label={showToken ? 'Hide connection token' : 'Show connection token'} onClick={() => setShowToken(!showToken)}>{showToken ? 'Hide' : 'Show'}</button></span></label>
      </div>
      <p className="network-note">Use a trusted LAN or VPN. HTTP connections carry tab URLs, screenshots, and the token without encryption. Anyone with this token can read shared sessions and, in client mode, request restores. Browser profiles and logins stay on their machine.</p>
      <div className="network-status" role="status"><span className={`tiny-dot ${network.listening ? 'green' : 'gray'}`}/>{network.error || (network.listening ? network.restoring ? 'Restoring a session on this machine…' : network.config.mode === 'client' ? 'Client ready · waiting for a restore request' : 'Sharing local sessions' : 'Network sharing is off')}{network.listening && network.addresses.map((address) => <code key={address}>{address}</code>)}</div>
      <div className="section-heading"><h2>Connect to instances</h2><button className="button secondary" onClick={() => update({ peers: [...config.peers, { id: crypto.randomUUID(), url: '', token: '' }] })} disabled={config.peers.length >= 32}><Plus size={14}/>Add instance</button></div>
      {config.peers.map((peer, index) => <div className="network-peer-fields" key={peer.id}><label>Instance address<input className="form-input" placeholder="http://192.168.1.20:45831" value={peer.url} onChange={(event) => update({ peers: config.peers.map((item) => item.id === peer.id ? { ...item, url: event.target.value } : item) })}/></label><label>Instance token<input className="form-input" type="password" autoComplete="off" value={peer.token} onChange={(event) => update({ peers: config.peers.map((item) => item.id === peer.id ? { ...item, token: event.target.value } : item) })}/></label><button className="icon-button" aria-label={`Remove instance ${index + 1}`} onClick={() => update({ peers: config.peers.filter((item) => item.id !== peer.id) })}><Trash2 size={16}/></button></div>)}
      <button className="button primary" disabled={saving} onClick={async () => { setSaving(true); try { await onConfigure(config); } finally { setSaving(false); } }}>{saving ? 'Applying…' : 'Apply network settings'}</button>
    </div>
    <div className="network-instances">
      <h2>Connected machines</h2>
      {!network.peers.length && <p>Add each machine’s address and connection token above. Connected timelines update every two seconds.</p>}
      {network.peers.map((peer) => <article className="network-instance" key={peer.id}>
        <header><Globe2 size={18}/><div><h3>{peer.data?.name || peer.url}</h3><small>{peer.url}</small></div><span className={`badge ${peer.connected ? 'live-badge' : ''}`}>{peer.connected ? peer.data?.mode === 'client' ? 'CLIENT' : 'HOST' : 'OFFLINE'}</span></header>
        {peer.error && <p className="form-error">{peer.error} Retrying automatically.</p>}
        {!peer.connected && peer.lastSeen && <p>Last connected {new Date(peer.lastSeen).toLocaleTimeString()}. Displayed data is from that connection.</p>}
        {peer.data?.restoring && <p role="status">This client is restoring a session…</p>}
        <h4>Open timelines</h4>
        {peer.data?.state.sessions.map((runtime) => <div className="network-session" key={runtime.session.id}><div><strong>{runtime.session.name}</strong><small>{runtime.session.tabs.length} tabs · {runtime.status === 'live' ? 'Recording' : runtime.status}</small></div><button className="button secondary" onClick={() => onView(peer.id, runtime.session.id)}>View timeline</button></div>)}
        {!peer.data?.state.sessions.length && <p>No open timelines on this machine.</p>}
        <h4>Saved on this machine</h4>
        {peer.data?.savedSessions.map((session) => <div className="network-session" key={session.id}><div><strong>{session.name}</strong><small>{session.tabCount} tabs · {new Date(session.startedAt).toLocaleDateString()}</small></div><button className="button secondary" disabled={!peer.connected || peer.data?.mode !== 'client' || peer.data.restoring || pending !== null} title="Reopen this saved session on its own machine" onClick={async () => { setPending(`${peer.id}:${session.id}`); try { await onRestore(peer.id, session.id); } finally { setPending(null); } }}><RefreshCw size={13}/>{pending === `${peer.id}:${session.id}` ? 'Restoring…' : 'Resume on client'}</button></div>)}
        {!peer.data?.savedSessions.length && <p>No saved sessions on this machine.</p>}
        {peer.connected && peer.data?.mode !== 'client' && <p>Enable client mode on this machine to accept restore requests.</p>}
      </article>)}
    </div>
  </section>;
}
