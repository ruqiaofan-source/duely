'use strict';

/**
 * Static content for the PLAY mini-games.
 *
 * QUIZ: [question, correct answer, wrong1, wrong2, wrong3]. Options are
 * shuffled per run on the server, so the correct one is always listed first
 * here. Only settled, stable facts go in this list: nothing from a season that
 * is still running and nothing that a single match could change. When adding a
 * question, check it against a primary source first.
 */
const QUIZ = [
  // World Cups
  ['Who won the 2022 World Cup?', 'Argentina', 'France', 'Croatia', 'Brazil'],
  ['Who won the 2018 World Cup?', 'France', 'Croatia', 'Belgium', 'England'],
  ['Who won the 2014 World Cup?', 'Germany', 'Argentina', 'Netherlands', 'Brazil'],
  ['Who won the 2010 World Cup?', 'Spain', 'Netherlands', 'Germany', 'Uruguay'],
  ['Who won the 2006 World Cup?', 'Italy', 'France', 'Germany', 'Portugal'],
  ['Who scored the winning goal in the 2014 World Cup final?', 'Mario Götze', 'Thomas Müller', 'Miroslav Klose', 'André Schürrle'],
  ['Who scored a hat-trick in the 2022 World Cup final?', 'Kylian Mbappé', 'Lionel Messi', 'Ángel Di María', 'Olivier Giroud'],
  ['Which country hosted the 2018 World Cup?', 'Russia', 'Qatar', 'Brazil', 'Germany'],
  ['Which country hosted the 2010 World Cup?', 'South Africa', 'Brazil', 'Germany', 'Japan'],
  ['Which country has won the most men\'s World Cups?', 'Brazil', 'Germany', 'Italy', 'Argentina'],
  ['Who did Zinedine Zidane headbutt in the 2006 World Cup final?', 'Marco Materazzi', 'Fabio Cannavaro', 'Gennaro Gattuso', 'Alessandro Nesta'],
  ['Who scored the "Hand of God" goal against England in 1986?', 'Diego Maradona', 'Jorge Valdano', 'Mario Kempes', 'Gabriel Batistuta'],
  ['Who won the 2023 Women\'s World Cup?', 'Spain', 'England', 'USA', 'Sweden'],

  // Euros and Copa
  ['Who won Euro 2024?', 'Spain', 'England', 'France', 'Germany'],
  ['Who did Spain beat in the Euro 2024 final?', 'England', 'France', 'Italy', 'Germany'],
  ['In which city was the Euro 2024 final played?', 'Berlin', 'Munich', 'Dortmund', 'Hamburg'],
  ['Who won Euro 2020 (played in 2021)?', 'Italy', 'England', 'Spain', 'Denmark'],
  ['Who won Euro 2016?', 'Portugal', 'France', 'Wales', 'Germany'],
  ['Who scored the winner in the Euro 2016 final?', 'Éder', 'Cristiano Ronaldo', 'Nani', 'Renato Sanches'],
  ['Which country shocked everyone by winning Euro 2004?', 'Greece', 'Portugal', 'Czech Republic', 'Denmark'],
  ['Who won Women\'s Euro 2025?', 'England', 'Spain', 'Germany', 'Sweden'],
  ['Who won the 2024 Copa América?', 'Argentina', 'Colombia', 'Uruguay', 'Brazil'],
  ['Which nation has won the Africa Cup of Nations the most times?', 'Egypt', 'Cameroon', 'Ghana', 'Nigeria'],
  ['Who won the 2023 Africa Cup of Nations (played in 2024)?', 'Ivory Coast', 'Nigeria', 'Senegal', 'Morocco'],

  // Champions League
  ['Who won the 2024 Champions League?', 'Real Madrid', 'Borussia Dortmund', 'Bayern Munich', 'Man City'],
  ['Who won the 2025 Champions League?', 'PSG', 'Inter', 'Arsenal', 'Barcelona'],
  ['What was the score in the 2025 Champions League final?', 'PSG 5-0 Inter', 'PSG 2-1 Inter', 'PSG 3-0 Inter', 'PSG 1-0 Inter'],
  ['Who won the 2023 Champions League?', 'Man City', 'Inter', 'Real Madrid', 'AC Milan'],
  ['Who scored the winner in the 2023 Champions League final?', 'Rodri', 'Erling Haaland', 'Kevin De Bruyne', 'Phil Foden'],
  ['Who won the 2022 Champions League?', 'Real Madrid', 'Liverpool', 'Man City', 'Villarreal'],
  ['Who won the 2021 Champions League?', 'Chelsea', 'Man City', 'PSG', 'Real Madrid'],
  ['Who won the 2019 Champions League?', 'Liverpool', 'Tottenham', 'Ajax', 'Barcelona'],
  ['Who won the 2012 Champions League final in Munich?', 'Chelsea', 'Bayern Munich', 'Barcelona', 'Real Madrid'],
  ['Who came back from 3-0 down to win the 2005 Champions League final?', 'Liverpool', 'AC Milan', 'Chelsea', 'Juventus'],
  ['Who did Man United beat in the 1999 Champions League final?', 'Bayern Munich', 'Juventus', 'Barcelona', 'Valencia'],
  ['Which club has won the most European Cups and Champions Leagues?', 'Real Madrid', 'AC Milan', 'Bayern Munich', 'Liverpool'],

  // Premier League
  ['Which club went the whole 2003-04 Premier League season unbeaten?', 'Arsenal', 'Chelsea', 'Man United', 'Liverpool'],
  ['Which club has won the most Premier League titles?', 'Man United', 'Man City', 'Chelsea', 'Arsenal'],
  ['Who won the Premier League in 2015-16 at 5000-1?', 'Leicester City', 'Tottenham', 'Arsenal', 'West Ham'],
  ['Who is the Premier League\'s all-time top scorer?', 'Alan Shearer', 'Harry Kane', 'Wayne Rooney', 'Thierry Henry'],
  ['How many Premier League goals did Erling Haaland score in 2022-23?', '36', '32', '34', '38'],
  ['Which club won four Premier League titles in a row from 2021 to 2024?', 'Man City', 'Liverpool', 'Arsenal', 'Chelsea'],
  ['Who won the Premier League in 2024-25?', 'Liverpool', 'Arsenal', 'Man City', 'Chelsea'],
  ['Who managed Liverpool to the 2024-25 Premier League title?', 'Arne Slot', 'Jürgen Klopp', 'Xabi Alonso', 'Mauricio Pochettino'],
  ['Who scored the 93:20 title winner for Man City against QPR in 2012?', 'Sergio Agüero', 'Edin Džeko', 'Carlos Tevez', 'Mario Balotelli'],

  // Europe's other leagues
  ['Who won the Bundesliga unbeaten in 2023-24?', 'Bayer Leverkusen', 'Bayern Munich', 'Borussia Dortmund', 'RB Leipzig'],
  ['Who managed Leverkusen\'s unbeaten 2023-24 Bundesliga season?', 'Xabi Alonso', 'Julian Nagelsmann', 'Thomas Tuchel', 'Jürgen Klopp'],
  ['Who scored 41 Bundesliga goals in 2020-21 to break Gerd Müller\'s record?', 'Robert Lewandowski', 'Erling Haaland', 'Harry Kane', 'Thomas Müller'],
  ['Robert Lewandowski once scored five goals in how many minutes for Bayern?', '9', '15', '20', '12'],
  ['Who won Serie A in 2022-23, their first title since 1990?', 'Napoli', 'Inter', 'AC Milan', 'Lazio'],
  ['Who won La Liga in 2024-25?', 'Barcelona', 'Real Madrid', 'Atlético Madrid', 'Athletic Club'],
  ['Who won the Bundesliga in 2024-25?', 'Bayern Munich', 'Bayer Leverkusen', 'Borussia Dortmund', 'Eintracht Frankfurt'],
  ['Which club is nicknamed "The Old Lady"?', 'Juventus', 'AC Milan', 'Roma', 'Torino'],
  ['Which two clubs share the San Siro?', 'AC Milan and Inter', 'Roma and Lazio', 'Juventus and Torino', 'Genoa and Sampdoria'],
  ['Which club plays its home games at Signal Iduna Park?', 'Borussia Dortmund', 'Schalke', 'Bayern Munich', 'Bayer Leverkusen'],

  // Players and awards
  ['Who won the 2023 Ballon d\'Or?', 'Lionel Messi', 'Erling Haaland', 'Kylian Mbappé', 'Kevin De Bruyne'],
  ['Who won the 2024 Ballon d\'Or?', 'Rodri', 'Vinícius Júnior', 'Jude Bellingham', 'Dani Carvajal'],
  ['Who won the 2025 Ballon d\'Or?', 'Ousmane Dembélé', 'Lamine Yamal', 'Mohamed Salah', 'Vitinha'],
  ['Who won the 2018 Ballon d\'Or?', 'Luka Modrić', 'Cristiano Ronaldo', 'Lionel Messi', 'Antoine Griezmann'],
  ['Who won the 2022 Ballon d\'Or?', 'Karim Benzema', 'Sadio Mané', 'Kevin De Bruyne', 'Robert Lewandowski'],
  ['Who has won the most men\'s Ballon d\'Or awards?', 'Lionel Messi', 'Cristiano Ronaldo', 'Michel Platini', 'Johan Cruyff'],
  ['Which club did Neymar join for a world record fee in 2017?', 'PSG', 'Real Madrid', 'Man City', 'Chelsea'],
  ['Which MLS club did Lionel Messi join in 2023?', 'Inter Miami', 'LA Galaxy', 'New York City', 'LAFC'],
  ['Which Saudi club did Cristiano Ronaldo join in 2023?', 'Al-Nassr', 'Al-Hilal', 'Al-Ittihad', 'Al-Ahli'],
  ['Who is Poland\'s all-time top scorer?', 'Robert Lewandowski', 'Grzegorz Lato', 'Włodzimierz Lubański', 'Arkadiusz Milik'],

  // Other sports
  ['Who has won the most men\'s Grand Slam singles titles?', 'Novak Djokovic', 'Rafael Nadal', 'Roger Federer', 'Pete Sampras'],
  ['Which driver won four F1 world titles in a row from 2021 to 2024?', 'Max Verstappen', 'Lewis Hamilton', 'Charles Leclerc', 'Lando Norris'],
  ['Lewis Hamilton shares the record for most F1 titles with who?', 'Michael Schumacher', 'Sebastian Vettel', 'Ayrton Senna', 'Alain Prost'],
  ['Who won the 2023 Rugby World Cup?', 'South Africa', 'New Zealand', 'France', 'England'],
  ['Who won the 2023 Cricket World Cup?', 'Australia', 'India', 'England', 'New Zealand'],
  ['Who completed golf\'s career Grand Slam by winning the 2025 Masters?', 'Rory McIlroy', 'Scottie Scheffler', 'Jon Rahm', 'Justin Rose'],
];

module.exports = { QUIZ };
