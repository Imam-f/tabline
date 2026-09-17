import type { Session } from './types';

export function demoThumbnail(site: string, accent: string, dark = false) {
  const bg = dark ? '#15181f' : '#ffffff';
  const ink = dark ? '#f1f1f4' : '#202635';
  const muted = dark ? '#2d323e' : '#edf0f5';
  const title = site === 'React' ? 'The library for web and native user interfaces' : site === 'GitHub' ? 'Let’s build from here.' : site === 'Linear' ? 'The system for modern software development' : site === 'Figma' ? 'Make room for your next big idea.' : site === 'Vercel' ? 'Your complete platform for the web.' : 'A little curiosity goes a long way.';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="350" viewBox="0 0 560 350"><rect width="560" height="350" fill="${bg}"/><rect width="560" height="36" fill="${muted}"/><circle cx="15" cy="18" r="3" fill="#afb5c2"/><circle cx="26" cy="18" r="3" fill="#afb5c2"/><circle cx="37" cy="18" r="3" fill="#afb5c2"/><rect x="80" y="10" width="340" height="16" rx="5" fill="${bg}"/><text x="24" y="70" fill="${ink}" font-family="Arial,sans-serif" font-size="16" font-weight="bold">${site}</text><rect x="305" y="58" width="38" height="5" rx="2" fill="${muted}"/><rect x="356" y="58" width="38" height="5" rx="2" fill="${muted}"/><rect x="408" y="58" width="38" height="5" rx="2" fill="${muted}"/><rect x="470" y="50" width="63" height="22" rx="5" fill="${accent}"/><circle cx="280" cy="125" r="21" fill="${accent}" opacity=".2"/><text x="280" y="132" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="bold" fill="${accent}">${site === 'React' ? '⚛' : site.charAt(0)}</text><text x="280" y="182" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="bold" fill="${ink}">${site === 'React' ? 'React' : site === 'Linear' ? 'Build something remarkable.' : site === 'Figma' ? 'Nothing great is made alone.' : title}</text><text x="280" y="207" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="${dark ? '#a7adba' : '#727a89'}">${site === 'React' ? title : 'Bring your ideas to life. One step at a time.'}</text><rect x="215" y="227" width="130" height="28" rx="14" fill="${accent}"/><text x="280" y="245" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" fill="${dark ? '#161a24' : '#fff'}">${site === 'React' ? 'Learn React' : 'Get started'}</text><rect x="65" y="291" width="130" height="70" rx="8" fill="${muted}"/><rect x="215" y="291" width="130" height="70" rx="8" fill="${muted}"/><rect x="365" y="291" width="130" height="70" rx="8" fill="${muted}"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function makeDemo(): Session {
  const start = Date.now() - 32 * 60000;
  const entries: [string, string, string, number, number | null, string | null, string, boolean][] = [
    ['google', 'Exploring a new idea', 'https://www.google.com/search?q=building+better+interfaces', 0, 13, null, '#4285f4', false],
    ['github', 'GitHub · Build and ship software', 'https://github.com', 2, null, 'google', '#ad91ed', true],
    ['react', 'React', 'https://react.dev', 6, null, 'github', '#58c4dc', true],
    ['react-learn', 'Quick Start – React', 'https://react.dev/learn', 12, null, 'react', '#58c4dc', true],
    ['figma', 'Figma: The Collaborative Interface', 'https://www.figma.com', 10, 25, 'google', '#e782ab', false],
    ['linear', 'Linear – Plan and build products', 'https://linear.app', 17, null, 'figma', '#a599f5', true],
    ['vercel', 'Vercel: Build and deploy the web', 'https://vercel.com', 21, null, 'github', '#d7e1f5', true],
  ];
  return {
    id: 'demo', name: 'A little productive wandering', browser: 'helium', startedAt: start, endedAt: null,
    tabs: entries.map(([id, title, url, opened, closed, openerId, accent, dark]) => ({
      id, title, url, openedAt: start + opened * 60000, closedAt: closed === null ? null : start + closed * 60000,
      openerId, windowId: id === 'vercel' ? '2' : '1', desktopId: 'Demo desktop', windowHistory: [{ windowId: id === 'vercel' ? '2' : '1', desktopId: 'Demo desktop', at: start + opened * 60000 }], groupId: ['react', 'react-learn'].includes(id) ? 1 : null, groupTitle: ['react', 'react-learn'].includes(id) ? 'Learning React' : null, groupColor: ['react', 'react-learn'].includes(id) ? 'cyan' : null, groupCollapsed: false, groupHistory: [], thumbnail: demoThumbnail(id.startsWith('react') ? 'React' : id.charAt(0).toUpperCase() + id.slice(1), accent, dark),
      thumbnailAt: Date.now() - 12000,
      navigations: [{ url, title, at: start + opened * 60000 }],
    })),
  };
}
