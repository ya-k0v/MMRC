const RU_LETTERS = [
  ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ'],
  ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э'],
  ['я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю']
];

const EN_LETTERS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm']
];

let currentLayout = 'ru';
let isShifted = false;
let inputElement = null;
let keyboardEl = null;
let isKeyboardVisible = false;
let isInteractingWithKeyboard = false;

function createKeyboard() {
  if (keyboardEl) return keyboardEl;

  keyboardEl = document.createElement('div');
  keyboardEl.id = 'heroKeyboard';
  keyboardEl.className = 'hero-keyboard';
  keyboardEl.style.display = 'none';

  keyboardEl.addEventListener('mousedown', (e) => { e.preventDefault(); isInteractingWithKeyboard = true; });
  keyboardEl.addEventListener('touchstart', (e) => { e.preventDefault(); isInteractingWithKeyboard = true; });

  document.body.appendChild(keyboardEl);
  return keyboardEl;
}

function renderLayout() {
  if (!keyboardEl) return;

  const letters = currentLayout === 'ru' ? RU_LETTERS : EN_LETTERS;

  let html = '<div class="kb-rows">';

  for (const row of letters) {
    html += '<div class="kb-row">';
    for (const ch of row) {
      const display = isShifted ? ch.toUpperCase() : ch;
      html += `<button class="kb-key kb-key-letter" data-char="${ch}">${display}</button>`;
    }
    html += '</div>';
  }

  html += '<div class="kb-row kb-row-bottom">';
  html += `<button class="kb-key kb-key-shift" data-action="shift">${isShifted ? '⇧' : 'Shift'}</button>`;
  html += `<button class="kb-key kb-key-lang" data-action="lang">${currentLayout === 'ru' ? 'EN' : 'RU'}</button>`;
  html += `<button class="kb-key kb-key-space" data-action="space">Пробел</button>`;
  html += `<button class="kb-key kb-key-bspace" data-action="bspace">⌫</button>`;
  html += `<button class="kb-key kb-key-clear" data-action="clear">Очистить</button>`;
  html += '</div>';

  html += '</div>';

  keyboardEl.innerHTML = html;

  keyboardEl.querySelectorAll('.kb-key').forEach(btn => {
    btn.addEventListener('click', () => handleKeyPress(btn));
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      handleKeyPress(btn);
    });
  });
}

function handleKeyPress(btn) {
  if (!inputElement) return;

  const char = btn.dataset.char;
  const action = btn.dataset.action;

  if (char) {
    const value = isShifted ? char.toUpperCase() : char;
    const start = inputElement.selectionStart;
    const end = inputElement.selectionEnd;
    const currentValue = inputElement.value;
    inputElement.value = currentValue.substring(0, start) + value + currentValue.substring(end);
    inputElement.setSelectionRange(start + 1, start + 1);
    if (isShifted) {
      isShifted = false;
      renderLayout();
    }
  } else if (action === 'shift') {
    isShifted = !isShifted;
    renderLayout();
  } else if (action === 'lang') {
    currentLayout = currentLayout === 'ru' ? 'en' : 'ru';
    isShifted = false;
    renderLayout();
  } else if (action === 'space') {
    const start = inputElement.selectionStart;
    const end = inputElement.selectionEnd;
    const currentValue = inputElement.value;
    inputElement.value = currentValue.substring(0, start) + ' ' + currentValue.substring(end);
    inputElement.setSelectionRange(start + 1, start + 1);
  } else if (action === 'bspace') {
    const start = inputElement.selectionStart;
    const end = inputElement.selectionEnd;
    if (start === end && start > 0) {
      const currentValue = inputElement.value;
      inputElement.value = currentValue.substring(0, start - 1) + currentValue.substring(end);
      inputElement.setSelectionRange(start - 1, start - 1);
    } else if (start !== end) {
      const currentValue = inputElement.value;
      inputElement.value = currentValue.substring(0, start) + currentValue.substring(end);
      inputElement.setSelectionRange(start, start);
    }
  } else if (action === 'clear') {
    inputElement.value = '';
  }

  inputElement.dispatchEvent(new Event('input', { bubbles: true }));
  inputElement.focus();
}

export function attachKeyboard(input) {
  inputElement = input;
  createKeyboard();
  renderLayout();
}

export function showKeyboard() {
  if (!keyboardEl) createKeyboard();
  if (isKeyboardVisible) return;
  isKeyboardVisible = true;
  keyboardEl.style.display = 'block';
  requestAnimationFrame(() => keyboardEl.classList.add('kb-visible'));
}

export function hideKeyboard() {
  if (!isKeyboardVisible) return;
  isKeyboardVisible = false;
  keyboardEl.classList.remove('kb-visible');
  keyboardEl.style.display = 'none';
}

export function toggleKeyboard() {
  if (isKeyboardVisible) {
    hideKeyboard();
  } else {
    showKeyboard();
  }
}

export function isKeyboardActive() {
  return isInteractingWithKeyboard;
}

export function resetKeyboardInteraction() {
  isInteractingWithKeyboard = false;
}
