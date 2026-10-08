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
    'Answer': 'Odpowiedz', 'Games': 'Gry', 'Ranking': 'Ranking',
    'Friends': 'Znajomi', 'Games 🕹️': 'Gry 🕹️', 'Challenge ⚔️': 'Wyzwanie ⚔️',
    'Challenge a friend →': 'Wyzwij znajomego →', 'Post a public challenge →': 'Opublikuj wyzwanie →',
    '🌍 Post it to Answer →': '🌍 Opublikuj w Odpowiedz →',
    'Posted to Answer 🌍 — anyone on Clashly can take the other side': 'Opublikowane w Odpowiedz 🌍 — każdy na Clashly może przyjąć drugą stronę',
    'A friend challenge gives you a link to send. A public challenge goes straight onto the Answer tab for anyone to take.': 'Wyzwanie znajomego daje ci link do wysłania. Publiczne wyzwanie trafia od razu do zakładki Odpowiedz, gdzie każdy może je przyjąć.',
    'Answer public challenges 📬': 'Odpowiedz na publiczne wyzwania 📬',
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
    // v22 turnstile landing
    'THINK YOU': 'MYŚLISZ, ŻE', 'KNOW BALL?': 'ZNASZ FUTBOL?', 'PROVE IT.': 'UDOWODNIJ TO.',
    "TONIGHT'S CALL": 'DZISIEJSZY TYP',
    'one tap, no account, on the record': 'jedno tapnięcie, bez konta, na rekordzie',
    "You're on the record — see how it lands at full time.": 'Jesteś na rekordzie — zobacz, jak to wyjdzie po meczu.',
    'CHALLENGE A MATE': 'WYZWIJ ZIOMKA', 'the record starts here': 'tu zaczyna się rekord',
    'CALL THE WEEKEND': 'WYTYPUJ WEEKEND', '6 games, one board': '6 meczów, jedna tabela',
    'THE ARCADE': 'ARCADE', 'skill games, points count': 'gry na refleks, punkty się liczą',
    'No money, no prizes, just receipts. 18+': 'Bez pieniędzy, bez nagród, tylko paragony. 18+',
    '⚡ Play games. Earn points. Up to 30 a day on the public board.': '⚡ Graj w gierki. Zbieraj punkty. Do 30 dziennie do publicznego rankingu.',
    '🗓️ Call the whole weekend →': '🗓️ Wytypuj cały weekend →',
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
    // v13: first-run home + the link-free brag
    'Duel #1 👋': 'Pojedynek #1 👋',
    'Pick a match, back yourself, send the link. Your mate takes the other side and the record starts.': 'Wybierz mecz, postaw na siebie, wyślij link. Ziomek bierze drugą stronę i bilans rusza.',
    '⚔️ Challenge a mate →': '⚔️ Wyzwij ziomka →',
    '🛒 Or take a live bet from the Arena': '🛒 Albo weź zakład z Areny',
    '📋 Copy the scoreline': '📋 Skopiuj wynik',
    'No link, just the record. Paste it in the group chat.': 'Bez linku, sam bilans. Wklej na grupie.',
    // v14: settle-up card, accept reassurance, league solo state
    'Kickoff in': 'Start za', 'Kicks off in': 'Start za', 'minutes': 'minut',
    // v15: season-long calls
    'Settle by': 'Rozliczcie do', 'It happens ✅': 'Wydarzy się ✅', 'No chance ❌': 'Nie ma szans ❌',
    'It happened ✅': 'Wydarzyło się ✅', "It didn't ❌": 'Nie wydarzyło się ❌',
    'How did it end up?': 'Jak to się skończyło?', 'The call': 'Typ',
    '🗓️ Season-long call…': '🗓️ Typ na cały sezon…', 'Settle by (optional)': 'Rozliczcie do (opcjonalnie)',
    'Yes — it happens': 'Tak — wydarzy się', 'No chance': 'Nie ma szans',
    'Settled 🗓️': 'Rozliczone 🗓️',
    '📲 Send the table to the group': '📲 Wyślij tabelę na grupę',
    // v17: the weekly call
    '📣 The weekly call': '📣 Typ tygodnia', 'Draw': 'Remis',
    // v18: telling the three public surfaces apart
    'public · no bet': 'publicznie · bez zakładu', 'Announce →': 'Ogłoś →',
    'points banked': 'punktów zdobytych',
    '🗓️ Call the whole weekend →': '🗓️ Typuj cały weekend →',
    '🗓️ Call the weekend →': '🗓️ Typuj weekend →', '🕹️ The Arcade →': '🕹️ Arcade →',
    "Right calls bank points. The fewer people who agreed with you, the more it's worth. Wrong calls score nothing — there's nothing to lose.": 'Trafione typy dają punkty. Im mniej osób się z tobą zgadzało, tym więcej warte. Za pudło zero, nie da się nic stracić.',
    'An announcement to everyone on Clashly. No opponent, no stake, no link — just a take on the record.': 'Ogłoszenie do wszystkich na Clashly. Bez przeciwnika, bez stawki, bez linku, po prostu twoja opinia na zapis.',
    '🗣️ Reply on the Terrace': '🗣️ Odpowiedz na Trybunie', '⚔️ Duel them on it': '⚔️ Wyzwij go o to',
    'Reply is public and free. A duel makes a link you send them.': 'Odpowiedź jest publiczna i za darmo. Pojedynek tworzy link, który mu wysyłasz.',
    'Copy it for the group 📋': 'Skopiuj na grupę 📋',
    '🔒 Kicked off. Calls are closed.': '🔒 Mecz się zaczął. Typowanie zamknięte.',
    'Full time.': 'Koniec meczu.', '✅ You called it.': '✅ Trafiłeś.', '❌ You got this one wrong.': '❌ Tym razem pudło.',
    'On the record 📣': 'Zapisane 📣',
    'finish above': 'wyżej w tabeli', 'sacked by Xmas': 'zwolniony do świąt',
    '🗓️ Call the whole season': '🗓️ Typuj cały sezon', 'Make a season call →': 'Typuj na sezon →',
    'top scorer': 'król strzelców', 'relegation': 'spadek',
    "By accepting you confirm you're 18 or over.": 'Akceptując potwierdzasz, że masz ukończone 18 lat.',
    'Full time 🏁 Settle up': 'Koniec meczu 🏁 Rozliczcie się',
    'Your mate reported the result — confirm it': 'Ziomek zgłosił wynik, potwierdź go',
    'Match finished — report the result': 'Mecz zakończony, zgłoś wynik',
    'Confirm ✓': 'Potwierdź ✓', 'Report →': 'Zgłoś →',
    'Unsettled duels never reach the record. Thirty seconds, on it goes.': 'Nierozliczone pojedynki nie trafiają do bilansu. Trzydzieści sekund i gra.',
    "Free. No money. No sign-up. You're just going on the record.": 'Za darmo. Bez pieniędzy. Bez rejestracji. Po prostu idzie na zapis.',
    '👑 A table of one wins nothing. Send the link and the season starts when the first mate joins.': '👑 Tabela jednego nic nie wygrywa. Wyślij link, sezon rusza gdy dołączy pierwszy ziomek.',
    'Send it to the group 📲': 'Wyślij na grupę 📲',
    // the three first-run steps — never translated before, now the whole first screen
    'Joined Clashly': 'Dołączyłeś do Clashly',
    'Back a call & set the stakes': 'Postaw typ i ustal stawkę',
    'Fire the link — a mate takes the other side': 'Wyślij link — ziomek bierze drugą stronę',
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

    // v35 — Credits, Home, Rank, Clash, Profile, PLAY
    'Rank': 'Ranking', 'Clash': 'Starcie', 'Play': 'Graj',
    'GET STARTED': 'ZACZYNAMY', 'NEXT': 'DALEJ', 'ENTER CLASHLY': 'WCHODZĘ DO CLASHLY',
    'Think you know sports better than everyone else?': 'Myślisz, że znasz się na sporcie lepiej niż wszyscy?',
    'Predict. Compete. Prove it.': 'Typuj. Rywalizuj. Udowodnij to.',
    'HOW CLASHLY WORKS': 'JAK DZIAŁA CLASHLY',
    'You start with': 'Na start dostajesz', 'free Clashly Credits.': 'darmowych Kredytów Clashly.',
    'Use Credits to make sports predictions.': 'Używaj Kredytów do typowania wyników.',
    'Win Credits when your predictions are correct.': 'Wygrywaj Kredyty, gdy twoje typy się sprawdzą.',
    'Compete for a higher ranking.': 'Walcz o wyższe miejsce w rankingu.',
    'Challenge your friends.': 'Wyzywaj znajomych.',
    'CREDITS ARE THE GAME': 'KREDYTY TO GRA',
    'Clashly Credits are virtual in-game Credits.': 'Kredyty Clashly to wirtualne kredyty w grze.',
    'You can:': 'Możesz je:', 'earn them': 'zdobywać', 'risk them': 'ryzykować', 'win them': 'wygrywać', 'lose them': 'tracić',
    'use them in competitions': 'używać w rywalizacji', 'use them in selected mini-games': 'używać w wybranych mini-grach',
    'Credits have no cash value.': 'Kredyty nie mają wartości pieniężnej.',
    'There are no deposits or withdrawals.': 'Nie ma wpłat ani wypłat.',
    'READY?': 'GOTOWY?', 'Your first:': 'Twoje pierwsze:', 'are waiting.': 'czekają.', 'CREDITS': 'KREDYTÓW',
    "I'm 18 or over.": 'Mam ukończone 18 lat.',
    'Free to play. Virtual Credits only. 18+': 'Gra za darmo. Tylko wirtualne Kredyty. 18+',
    'YOUR CREDITS': 'TWOJE KREDYTY', 'DAY STREAK': 'DNI Z RZĘDU', 'Skill': 'Umiejętności', 'Week': 'Tydzień',
    'CLAIM': 'ODBIERZ', 'claimed': 'odebrane',
    "TODAY'S CLASH": 'DZISIEJSZE STARCIE', 'Who wins?': 'Kto wygra?', 'MAKE YOUR PICK': 'TYPUJ',
    'YOUR PICK IS LOCKED.': 'TWÓJ TYP JEST ZABLOKOWANY.',
    'No picks yet. Be the first to call it.': 'Jeszcze nikt nie typował. Bądź pierwszy.',
    'Your live picks': 'Twoje aktywne typy', 'Trending predictions': 'Popularne typy', 'All matches →': 'Wszystkie mecze →',
    '🔥 DAILY GAME': '🔥 GRA DNIA', 'BEST SCORE': 'NAJLEPSZY WYNIK', 'YOUR SCORE': 'TWÓJ WYNIK', 'TOP PLAYER': 'NAJLEPSZY GRACZ',
    'PLAY NOW': 'GRAJ TERAZ', 'Your stats': 'Twoje statystyki', 'Profile →': 'Profil →',
    'Accuracy': 'Skuteczność', 'Win streak': 'Seria wygranych',
    'Weekly leaderboard': 'Ranking tygodnia', 'See the full ranking →': 'Zobacz pełny ranking →',
    '⚔️ CHALLENGE A FRIEND': '⚔️ WYZWIJ ZNAJOMEGO',
    'Pick a match, set the Credits, send the link. Prove who knows more.': 'Wybierz mecz, ustaw Kredyty, wyślij link. Udowodnij, kto wie więcej.',
    'FOUNDING MEMBERS': 'CZŁONKOWIE ZAŁOŻYCIELE', 'JOIN THE FIRST 20,000 CLASHLY PLAYERS.': 'DOŁĄCZ DO PIERWSZYCH 20 000 GRACZY CLASHLY.',
    "You're Founding Member": 'Jesteś Członkiem Założycielem', 'The badge is yours for good.': 'Odznaka zostaje z tobą na zawsze.',
    'CORRECT': 'TRAFIONY', 'WRONG': 'PUDŁO', 'FULL TIME': 'KONIEC MECZU', 'FULL TIME · YOU CALLED IT': 'KONIEC MECZU · TRAFIŁEŚ',
    'Go again. Nothing else to lose.': 'Typuj dalej.', 'Share it 📲': 'Udostępnij 📲',
    'Your Credits': 'Twoje Kredyty', 'Choose your prediction': 'Wybierz swój typ', 'Amount': 'Ile Kredytów',
    'RISK': 'RYZYKO', 'POTENTIAL WIN': 'MOŻLIWA WYGRANA', 'IF RIGHT': 'JEŚLI TRAFISZ',
    'Low risk': 'Niskie ryzyko', 'Medium risk': 'Średnie ryzyko', 'High risk': 'Wysokie ryzyko', 'Very high risk': 'Bardzo wysokie ryzyko',
    'Virtual Credits only. No cash value. The multiplier comes from the league table and how Clashly players are calling it.': 'Tylko wirtualne Kredyty, bez wartości pieniężnej. Mnożnik wynika z tabeli ligowej i typów graczy Clashly.',
    'Done': 'Gotowe', '⚔️ Dare a mate to take the other side': '⚔️ Rzuć wyzwanie kumplowi',
    'Settles automatically at full time.': 'Rozlicza się automatycznie po meczu.',
    'Make a prediction': 'Typuj mecz', 'NOT ENOUGH CREDITS': 'ZA MAŁO KREDYTÓW',
    'Where they came from': 'Skąd się wzięły',
    'Virtual in-game Credits. No cash value, no deposits, no withdrawals.': 'Wirtualne Kredyty w grze. Bez wartości pieniężnej, bez wpłat i wypłat.',
    'Weekly rankings reset every Monday. Every week is a new season.': 'Ranking tygodniowy zeruje się w każdy poniedziałek. Każdy tydzień to nowy sezon.',
    'Current rank': 'Obecne miejsce', 'Best rank': 'Najlepsze miejsce', 'Weekly wins': 'Wygrane w tygodniu', 'Weekly earnings': 'Bilans tygodnia',
    'GLOBAL': 'GLOBALNY', 'WEEKLY': 'TYGODNIOWY', 'FRIENDS': 'ZNAJOMI', 'YOU': 'TY',
    'Share my rank 📲': 'Udostępnij moje miejsce 📲', 'Past weeks': 'Poprzednie tygodnie',
    '⚔️ CLASH': '⚔️ STARCIE', 'PROVE WHO KNOWS MORE.': 'UDOWODNIJ, KTO WIE WIĘCEJ.',
    'Pick a match, back your call, put Credits on it. Your mate takes the other side. Winner takes the pool.': 'Wybierz mecz, obstaw swój typ Kredytami. Kumpel bierze drugą stronę. Zwycięzca zgarnia pulę.',
    '🌍 Post a public Clash': '🌍 Opublikuj publiczne starcie', 'Your move': 'Twój ruch', 'Live Clashes': 'Trwające starcia',
    'Waiting for a taker': 'Czeka na przeciwnika', 'Public Clashes': 'Publiczne starcia', 'History': 'Historia',
    'Open challenges from anyone on Clashly. Take one, win it.': 'Otwarte wyzwania od graczy Clashly. Weź jedno i wygraj.',
    'No public Clashes right now. Post the first one.': 'Brak publicznych starć. Opublikuj pierwsze.',
    'The Terrace 📣': 'Trybuna 📣', 'Announce →': 'Ogłoś →',
    'Say it to all of Clashly. No opponent, no Credits, just a take on the record.': 'Powiedz to całemu Clashly. Bez przeciwnika i Kredytów, tylko twoja opinia na rekordzie.',
    'Challenge a friend ⚔️': 'Wyzwij znajomego ⚔️', 'Post a public Clash 🌍': 'Publiczne starcie 🌍',
    'Pick the match, back your call, put Credits on it. Winner takes the pool.': 'Wybierz mecz, obstaw swój typ Kredytami. Zwycięzca zgarnia pulę.',
    'Clash Credits': 'Kredyty na starcie', 'No Credits': 'Bez Kredytów', 'Forfeit too? (optional)': 'Do tego fant? (opcjonalnie)',
    'Stake:': 'Stawka:', 'each · winner takes': 'każdy · zwycięzca bierze', 'No Credits on it. Bragging rights only.': 'Bez Kredytów. Tylko honor.',
    'Your Credits are held until the result. A void gives them back.': 'Kredyty czekają do wyniku. Anulowanie je zwraca.',
    'each. Winner takes': 'każdy. Zwycięzca bierze', 'Free. Virtual Credits only, no cash value. No sign-up.': 'Za darmo. Tylko wirtualne Kredyty, bez wartości pieniężnej. Bez rejestracji.',
    'Badges': 'Odznaki', 'PREDICTIONS': 'TYPY', 'CLASHES': 'STARCIA', 'MINI-GAMES': 'MINI-GRY',
    'SKILL': 'UMIEJĘTNOŚCI', 'GLOBAL RANK': 'MIEJSCE GLOBALNE', 'ACCURACY': 'SKUTECZNOŚĆ', 'WIN STREAK': 'SERIA WYGRANYCH', 'BEST RANK': 'NAJLEPSZE MIEJSCE',
    'Share my card 📲': 'Udostępnij kartę 📲', 'Share streak 🔥': 'Udostępnij serię 🔥', 'day streak': 'dni z rzędu',
    'FIRST PICK': 'PIERWSZY TYP', '5 WIN STREAK': '5 TRAFIEŃ Z RZĘDU', '10K CLUB': 'KLUB 10K', 'CLASH MASTER': 'MISTRZ STARĆ',
    'WEEKLY CHAMPION': 'MISTRZ TYGODNIA', 'FOOTBALL EXPERT': 'EKSPERT', '7 DAY STREAK': '7 DNI Z RZĘDU', 'FOUNDING MEMBER': 'CZŁONEK ZAŁOŻYCIEL',
    'Clashly Credits are virtual and have no cash value. No deposits, no withdrawals. 18+': 'Kredyty Clashly są wirtualne i nie mają wartości pieniężnej. Bez wpłat i wypłat. 18+',
    'PLAY TICKETS': 'BILETY DO GRY', 'Today from games:': 'Dziś z gier:',
    "YOU'VE USED TODAY'S PLAY TICKETS.": 'WYKORZYSTAŁEŚ DZISIEJSZE BILETY.', 'COME BACK TOMORROW.': 'WRÓĆ JUTRO.',
    'SPORTS GAMES': 'GRY SPORTOWE', 'PLAY': 'GRAJ', 'counts for your streak': 'liczy się do serii',
    '5 Play Tickets a day, never for sale. Up to 2,000 C a day from games. Predictions are where the big Credits are.': '5 biletów dziennie, nigdy na sprzedaż. Do 2000 C dziennie z gier. Prawdziwe Kredyty zdobywa się na typach.',
    'REWARD': 'DO ZDOBYCIA', 'YOUR BEST': 'TWÓJ REKORD', 'GLOBAL BEST': 'REKORD', 'Top scores today': 'Najlepsze wyniki dnia',
    '1 PLAY TICKET USED': '1 BILET WYKORZYSTANY', 'left today': 'zostało na dziś', 'BACK TO HOME': 'WRÓĆ DO STARTU',
    'Share my score 📲': 'Udostępnij wynik 📲', 'NEW PERSONAL BEST': 'NOWY REKORD',
    'TAP TO LOCK YOUR AIM': 'TAPNIJ, BY WYCELOWAĆ', 'NOW THE HEIGHT': 'TERAZ WYSOKOŚĆ', 'SHOOT': 'STRZAŁ', 'SAVED!': 'OBRONIONY!',
    'WHICH OUTCOME IS MOST LIKELY?': 'KTÓRY WYNIK JEST NAJBARDZIEJ PRAWDOPODOBNY?',
    'Next clue (lower reward)': 'Następna podpowiedź (mniej Kredytów)', 'GUESS': 'ZGADUJ', 'NOW!': 'TERAZ!', 'TOO EARLY': 'ZA WCZEŚNIE',
    'tap when it says NOW': 'tapnij, gdy pojawi się TERAZ',
    'DAILY REWARD': 'NAGRODA DNIA', 'DRAW': 'REMIS',
    'ACCEPT CLASH 🤝': 'PRZYJMIJ STARCIE 🤝', 'Clash is ON 🔒': 'Starcie trwa 🔒', 'Clash not found': 'Nie znaleziono starcia',
    'Waiting for your mate to accept…': 'Czekamy, aż kumpel przyjmie…', 'Call off this Clash': 'Odwołaj to starcie',
    'Clash called off': 'Starcie odwołane', 'This Clash was called off. It doesn\'t count, and any Credits went back.': 'Starcie zostało odwołane. Nie liczy się, a Kredyty wróciły.',
    'Call it off: no result counts': 'Odwołaj: wynik się nie liczy', 'Tap again to call it off': 'Tapnij jeszcze raz, by odwołać',
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
