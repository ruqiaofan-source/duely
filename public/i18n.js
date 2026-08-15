'use strict';
// Clashly i18n — lightweight phrase-level translation layer.
// A MutationObserver walks rendered text nodes / placeholders / titles and swaps
// exact English phrases for the active language. Dynamic interpolated sentences
// fall back to English. Toggle persists in localStorage ('clashly_lang').

(function () {
  const PL = {
    // tabs + chrome
    'Home': 'Start', 'Duels': 'Pojedynki', 'League': 'Liga', 'You': 'Ty',
    'Challenge': 'Wyzwij', 'Profile': 'Profil',
    'Player rankings 🏆': 'Ranking graczy 🏆', 'Weekly crowns': 'Korony tygodnia', 'My leagues': 'Moje ligi',
    'Settle up 💸': 'Rozliczenia 💸', '⚔️ All my duels →': '⚔️ Wszystkie pojedynki →',
    'All square — nobody owes anything. 🤝': 'Wszystko wyrównane — nikt nikomu nie wisi. 🤝',
    'Clashly holds no money — settle between yourselves (cash, BLIK, Revolut…) and mark the duel sorted.': 'Clashly nie trzyma pieniędzy — rozliczcie się między sobą (gotówka, BLIK, Revolut…) i oznaczcie pojedynek jako rozliczony.',
    'Settings': 'Ustawienia', 'Account': 'Konto', 'Sign out': 'Wyloguj', 'Sign in / create account': 'Zaloguj / załóż konto',
    'Edit name': 'Zmień imię', 'Play some duels and the crowns appear here.': 'Rozegraj kilka pojedynków, a korony się pojawią.',
    '📣 LATEST FROM THE TERRACE': '📣 ŚWIEŻE Z TRYBUNY',
    'See all →': 'Zobacz wszystkie →', 'Latest results 🏁': 'Ostatnie wyniki 🏁',
    'My form 📋': 'Moja forma 📋', 'Copy for the group chat 📋': 'Skopiuj do czatu 📋',
    '🏟️ Match of the Week': '🏟️ Mecz tygodnia', 'Make your call →': 'Typuj →',
    'Unpaid forfeits 🧾': 'Zaległe fanty 🧾', 'Collect →': 'Egzekwuj →', 'Make it right →': 'Wywiąż się →',
    'Clashly never forgets a forfeit. Settle it and mark the duel sorted.': 'Clashly nie zapomina fantów. Rozliczcie się i oznaczcie pojedynek jako załatwiony.',
    'Copied — paste it in the chat': 'Skopiowane — wklej na czacie', 'Receipt 🧾': 'Paragon 🧾',
    '← Back to home': '← Wróć na start',
    'Every card is a live bet waiting for an opponent. Take one, win it, bank': 'Każda karta to zakład czekający na przeciwnika. Weź go, wygraj i zgarnij',
    '📌 Yours, live in the Arena:': '📌 Twoje, wystawione na Arenie:',
    "🗣️ That's nonsense →": '🗣️ Bzdura →', '⚔️ Make them back it': '⚔️ Niech to udowodni',
    // onboarding
    'Think you know ball? Prove it. ⚽': 'Znasz się na futbolu? Udowodnij to. ⚽',
    'Call the match, your mate takes the other side, and the winner goes on the record. Clashly keeps the score — the rivalry does the rest.':
      'Typujesz mecz, ziomek bierze drugą stronę, a zwycięzca trafia do rejestru. Clashly liczy punkty — rywalizacja robi resztę.',
    'What should mates call you?': 'Jak mają na ciebie wołać?',
    "I'm 18 or over, and I'm here for the bragging rights.": 'Mam 18+ i gram o honor.',
    "Let's go →": 'Zaczynamy →',
    'I already have an account → sign in': 'Mam już konto → zaloguj się',
    'Pick a name': 'Wybierz imię', "Confirm you're 18+": 'Potwierdź, że masz 18+',
    // home cards
    'Your season': 'Twój sezon', 'Record': 'Bilans', 'Net': 'Saldo', 'Streak': 'Seria',
    '⚔️ Challenge a mate': '⚔️ Wyzwij ziomka',
    '⚔️ Create your first bet': '⚔️ Stwórz pierwszy zakład',
    'Get your first rivalry going 👋': 'Rozkręć pierwszą rywalizację 👋',
    'Big games coming up 🔥': 'Wielkie mecze przed nami 🔥',
    'Call it →': 'Typuj →',
    'High scores 🏆': 'Najlepsi 🏆',
    'This week ▾': 'Ten tydzień ▾', 'All time ▾': 'Cały czas ▾',
    'Hot streak': 'Gorąca seria', 'Most duels': 'Najwięcej pojedynków', 'Best record': 'Najlepszy bilans',
    'Biggest bottle': 'Największa wtopa', 'Fiercest rivalry': 'Najostrzejsza rywalizacja', 'Arena crown': 'Korona Areny',
    'The Arena ⚡': 'Arena ⚡',
    '🌍 Post an open challenge': '🌍 Rzuć otwarte wyzwanie',
    'Take it →': 'Przyjmij →',
    'No open challenges right now — throw the first glove. 🥊': 'Brak otwartych wyzwań — rzuć pierwszą rękawicę. 🥊',
    'Your open challenge is live in the Arena — waiting for a taker. 👀': 'Twoje wyzwanie wisi na Arenie — czeka na śmiałka. 👀',
    'The Terrace 📣': 'Trybuna 📣',
    'say it to everyone': 'powiedz to wszystkim',
    'Silence on the terrace. Someone say something spicy. 🌶️': 'Cisza na trybunie. Niech ktoś powie coś ostrego. 🌶️',
    '😤 rage bait': '😤 prowokacja', '🌍 call-out': '🌍 wyzwanie', '👑 flex': '👑 przechwałka',
    'Post': 'Wyślij',
    'Rivalries': 'Rywalizacje', 'Leagues': 'Ligi', 'Recent': 'Ostatnie',
    'Rematch →': 'Rewanż →', '+ New / join': '+ Nowa / dołącz',
    'Start a group league →': 'Załóż ligę ekipy →',
    'No rivalries yet. Challenge a mate and start one. 👀': 'Brak rywalizacji. Wyzwij ziomka i zacznij pierwszą. 👀',
    'Unfinished business ⚔️': 'Niedokończone sprawy ⚔️',
    // create sheet
    'Start a duel 🤝': 'Rozpocznij pojedynek 🤝',
    'Set the terms, send the link — you settle up between yourselves.': 'Ustal warunki, wyślij link — rozliczacie się między sobą.',
    'The match': 'Mecz',
    'What are you backing?': 'Na co stawiasz?',
    "What's on the line?": 'O co gramy?',
    'Trash talk (optional)': 'Zaczepka (opcjonalnie)',
    'Draw': 'Remis',
    'Lock it in & get link →': 'Zaklep i weź link →',
    '🌍 Lock it in & post to the Arena →': '🌍 Zaklep i wystaw na Arenę →',
    'Hold to lock — no backing out after.': 'Przytrzymaj, by zaklepać — potem nie ma odwrotu.',
    'Hold to lock it in': 'Przytrzymaj, żeby zaklepać',
    '🍺 pints': '🍺 browary', '👕 the shirt': '👕 koszulka', '😈 forfeit': '😈 fant',
    'e.g. loser buys the pints': 'np. przegrany stawia browary',
    'Announce it to all of Clashly…': 'Ogłoś to całemu Clashly…',
    'Say something worth saying': 'Powiedz coś konkretnego',
    // haggling
    '💬 Haggle — counter the terms': '💬 Targuj się — zaproponuj inne warunki',
    'Your counter — what should be on the line?': 'Twoja kontra — o co ma iść gra?',
    'e.g. loser wears the rival shirt': 'np. przegrany zakłada koszulkę rywala',
    'Add a jab (optional)': 'Dorzuć zaczepkę (opcjonalnie)',
    '…or money (optional)': '…albo kasa (opcjonalnie)',
    'Send counter-offer →': 'Wyślij kontrofertę →',
    'Counter-offer sent 💬': 'Kontroferta wysłana 💬',
    'Sign the fight card': 'Podpisz kartę walki',
    'Counter with a forfeit or a stake': 'Zaproponuj fant albo stawkę',
    'Offer declined': 'Oferta odrzucona',
    // v8 additions
    'Bragging rights': 'O honor',
    'Loser posts a public apology on the Terrace': 'Przegrany publicznie przeprasza na Trybunie',
    "Loser wears the winner's colours for a day": 'Przegrany przez dzień nosi barwy zwycięzcy',
    '🔊 Sound effects': '🔊 Efekty dźwiękowe',
    '🔔 Notifications (results, counter-offers)': '🔔 Powiadomienia (wyniki, kontroferty)',
    '🔔 Know the second your bet resolves or someone counters.': '🔔 Dowiedz się od razu, gdy zakład się rozstrzygnie albo ktoś złoży kontrofertę.',
    'Turn on': 'Włącz',
    'Notifications on 🔔': 'Powiadomienia włączone 🔔',
    // v7 additions
    '💬 Counter-offers waiting': '💬 Czekają kontroferty',
    'Review →': 'Zobacz →',
    '🛒 Take a live bet from the Arena →': '🛒 Weź zakład z Areny →',
    '⚔️ Or create your own': '⚔️ Albo stwórz własny',
    'Link it →': 'Powiąż →',
    'Install': 'Zainstaluj',
    '📲 Add Clashly to your home screen — it works like an app.': '📲 Dodaj Clashly do ekranu głównego — działa jak aplikacja.',
    // bet page
    'Take the bet 🤝': 'Przyjmij zakład 🤝',
    'Lock it in 🤝': 'Zaklep 🤝',
    'Report the final result': 'Zgłoś wynik meczu',
    'Report it again': 'Zgłoś jeszcze raz',
    'Confirm result ✓': 'Potwierdź wynik ✓',
    'Link copied': 'Link skopiowany', 'Invite copied': 'Zaproszenie skopiowane',
    // misc
    'Locked in': 'Zaklepane',
  };

  const LKEY = 'clashly_lang';
  const get = () => { try { return localStorage.getItem(LKEY) || 'en'; } catch { return 'en'; } };
  const set = (l) => { try { localStorage.setItem(LKEY, l); } catch {} };

  const tr = (s) => {
    if (get() !== 'pl' || !s) return null;
    const t = s.trim();
    if (PL[t] && PL[t] !== t) { const r = s.replace(t, PL[t]); return r !== s ? r : null; }
    return null;
  };

  function walk(node) {
    if (get() !== 'pl' || !node) return;
    const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    let n = node.nodeType === 3 ? node : w.nextNode();
    while (n) {
      if (n.nodeType === 3) { const r = tr(n.nodeValue); if (r) n.nodeValue = r; }
      else if (n.nodeType === 1) {
        for (const a of ['placeholder', 'aria-label', 'title']) {
          if (n.hasAttribute && n.hasAttribute(a)) { const r = tr(n.getAttribute(a)); if (r) n.setAttribute(a, r); }
        }
      }
      n = w.nextNode();
    }
  }

  function boot() {
    const targets = [document.getElementById('app'), document.getElementById('sheetPanel'), document.getElementById('tabbar'), document.getElementById('toast'), document.body];
    let busy = false;
    const obs = new MutationObserver((muts) => {
      if (busy) return;
      busy = true;
      try {
        for (const m of muts) {
          for (const a of m.addedNodes) walk(a);
          if (m.type === 'characterData') { const r = tr(m.target.nodeValue); if (r && r !== m.target.nodeValue) m.target.nodeValue = r; }
        }
      } finally { busy = false; }
    });
    const root = document.body;
    if (!root) return;
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    walk(root);
  }

  window.CLASHLY_I18N = {
    lang: get,
    toggle() { set(get() === 'pl' ? 'en' : 'pl'); location.reload(); },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
