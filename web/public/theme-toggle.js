const STORAGE_KEY = 'relaycast-theme';

function readTheme() {
  if (document.documentElement.dataset.theme === 'dark') {
    return 'dark';
  }

  if (document.documentElement.dataset.theme === 'light') {
    return 'light';
  }

  return 'dark';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;

  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures so the toggle still works for the session.
  }
}

function createIcon(theme) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  if (theme === 'dark') {
    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '4');

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute(
      'd',
      'M12 2v2.5M12 19.5V22M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77',
    );

    svg.append(circle, path);
    return svg;
  }

  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', 'M21 12.8A9 9 0 1 1 11.2 3a7.2 7.2 0 0 0 9.8 9.8Z');
  svg.append(path);
  return svg;
}

function renderButton(button, theme) {
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const actionLabel = `Switch to ${nextTheme} mode`;

  button.setAttribute('aria-label', actionLabel);
  button.setAttribute('title', actionLabel);
  button.replaceChildren(createIcon(theme));
}

const _toggleButtons = [];

function _syncAllButtons(theme) {
  for (const btn of _toggleButtons) {
    renderButton(btn, theme);
  }
}

function initThemeToggle(containerId) {
  const container = document.getElementById(containerId);
  if (!container) {
    return;
  }

  let theme = 'dark';

  try {
    const storedTheme = localStorage.getItem(STORAGE_KEY);
    if (storedTheme === 'light' || storedTheme === 'dark') {
      theme = storedTheme;
    } else {
      theme = readTheme();
    }
  } catch {
    theme = readTheme();
  }

  applyTheme(theme);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'theme-toggle';
  renderButton(button, theme);
  _toggleButtons.push(button);

  button.addEventListener('click', () => {
    const current = readTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    _syncAllButtons(next);
  });

  container.replaceChildren(button);
}

window.initThemeToggle = initThemeToggle;
