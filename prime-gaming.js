import { firefox } from 'playwright-firefox'; // stealth plugin needs no outdated playwright-extra
import { authenticator } from 'otplib';
import path from 'path';
import { jsonDb, datetime, stealth, filenamify, prompt, notify, html_game_list, handleSIGINT } from './util.js';
import { cfg } from './config.js';

// const URL_LOGIN = 'https://www.amazon.de/ap/signin'; // wrong. needs some session args to be valid?
const URL_CLAIM = 'https://gaming.amazon.com/home';

console.log(datetime(), 'started checking prime-gaming');

const db = await jsonDb('prime-gaming.json');
db.data ||= {};

handleSIGINT();

// https://playwright.dev/docs/auth#multi-factor-authentication
const context = await firefox.launchPersistentContext(cfg.dir.browser, {
  headless: cfg.headless,
  viewport: { width: cfg.width, height: cfg.height },
  locale: "en-US", // ignore OS locale to be sure to have english text for locators
});

// TODO test if needed
await stealth(context);

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist
// console.debug('userAgent:', await page.evaluate(() => navigator.userAgent));

const notify_games = [];

try {
  await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' }); // default 'load' takes forever
  // need to wait for some elements to exist before checking if signed in or accepting cookies:
  await Promise.any(['button:has-text("Sign in")', '[data-a-target="user-dropdown-first-name-text"]'].map(s => page.waitForSelector(s)));
  page.click('[aria-label="Cookies usage disclaimer banner"] button:has-text("Accept Cookies")').catch(_ => { }); // to not waste screen space when non-headless, TODO does not work reliably, need to wait for something else first?
  while (await page.locator('button:has-text("Sign in")').count() > 0) {
    console.error('Not signed in anymore.');
    await page.click('button:has-text("Sign in")');
    if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give user some extra time to log in
    console.info(`Login timeout is ${cfg.login_timeout/1000} seconds!`);
    if (cfg.pg_email && cfg.pg_password) console.info('Using email and password from environment.');
    else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
    const email = cfg.pg_email || await prompt({message: 'Enter email'});
    const password = email && (cfg.pg_password || await prompt({type: 'password', message: 'Enter password'}));
    if (email && password) {
      await page.fill('[name=email]', email);
      await page.fill('[name=password]', password);
      await page.check('[name=rememberMe]');
      await page.click('input[type="submit"]');
      page.waitForURL('**/ap/signin**').then(async () => { // check for wrong credentials
        const error = await page.locator('.a-alert-content').first().innerText();
        if (!error.trim.length) return;
        console.error('Login error:', error);
        await notify(`prime-gaming: login: ${error}`);
        await context.close(); // finishes potential recording
        process.exit(1);
      });
      // handle MFA, but don't await it
      page.waitForURL('**/ap/mfa**').then(async () => {
        console.log('Two-Step Verification - enter the One Time Password (OTP), e.g. generated by your Authenticator App');
        await page.check('[name=rememberDevice]');
        const otp = cfg.pg_otpkey && authenticator.generate(cfg.pg_otpkey) || await prompt({type: 'text', message: 'Enter two-factor sign in code', validate: n => n.toString().length == 6 || 'The code must be 6 digits!'}); // can't use type: 'number' since it strips away leading zeros and codes sometimes have them
        await page.type('input[name=otpCode]', otp.toString());
        await page.click('input[type="submit"]');
      }).catch(_ => { });
    } else {
      console.log('Waiting for you to login in the browser.');
      await notify('prime-gaming: no longer signed in and not enough options set for automatic login.');
      if (cfg.headless) {
        console.log('Run `SHOW=1 node prime-gaming` to login in the opened browser.');
        await context.close(); // finishes potential recording
        process.exit(1);
      }
    }
    await page.waitForURL('https://gaming.amazon.com/home?signedIn=true');
    if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);
  }
  const user = await page.locator('[data-a-target="user-dropdown-first-name-text"]').first().innerText();
  console.log(`Signed in as ${user}`);
  // await page.click('button[aria-label="User dropdown and more options"]');
  // const twitch = await page.locator('[data-a-target="TwitchDisplayName"]').first().innerText();
  // console.log(`Twitch user name is ${twitch}`);
  db.data[user] ||= {};

  await page.click('button[data-type="Game"]');
  const games_sel = 'div[data-a-target="offer-list-FGWP_FULL"]';
  await page.waitForSelector(games_sel);
  console.log('Number of already claimed games (total):', await page.locator(`${games_sel} p:has-text("Collected")`).count());
  const game_sel = `${games_sel} [data-a-target="item-card"]:has-text("Claim game")`;
  console.log('Number of free unclaimed games (Prime Gaming):', await page.locator(game_sel).count());
  const games = await page.$$(game_sel);
  // for (let i=1; i<=n; i++) {
  for (const card of games) {
    // const card = page.locator(`:nth-match(${game_sel}, ${i})`); // this will reevaluate after games are claimed and index will be wrong
    // const title = await card.locator('h3').first().innerText();
    const title = await (await card.$('.item-card-details__body__primary')).innerText();
    console.log('Current free game:', title);
    if (cfg.dryrun) continue;
    // const img = await (await card.$('img.tw-image')).getAttribute('src');
    // console.log('Image:', img);
    const p = path.resolve(cfg.dir.screenshots, 'prime-gaming', 'internal', `${filenamify(title)}.png`);
    await card.screenshot({ path: p });
    await (await card.$('button:has-text("Claim game")')).click();
    db.data[user][title] ||= { title, time: datetime(), store: 'internal' };
    notify_games.push({ title, status: 'claimed', url: URL_CLAIM });
    // await page.pause();
  }
  // claim games in external/linked stores. Linked: origin.com, epicgames.com; Redeem-key: gog.com, legacygames.com, microsoft
  let n;
  const game_sel_ext = `${games_sel} [data-a-target="item-card"]:has(p:text-is("Claim"))`;
  do {
    n = await page.locator(game_sel_ext).count();
    console.log('Number of free unclaimed games (external stores):', n);
    const card = await page.$(game_sel_ext);
    if (!card) break;
    const title = await (await card.$('.item-card-details__body__primary')).innerText();
    console.log('Current free game:', title);
    if (cfg.dryrun) continue;
    await (await card.$('text=Claim')).click(); // goes to URL of game, no need to wait
    await Promise.any([page.click('button:has-text("Claim now")'), page.click('button:has-text("Complete Claim")'), page.waitForSelector('div:has-text("Link game account")')]); // waits for navigation
    const store_text = await (await page.$('[data-a-target="hero-header-subtitle"]')).innerText();
    // Full game for PC [and MAC] on: gog.com, Origin, Legacy Games, EPIC GAMES, Battle.net
    // 3 Full PC Games on Legacy Games
    const store = store_text.toLowerCase().replace(/.* on /, '');
    console.log('  External store:', store);
    const url = page.url().split('?')[0];
    db.data[user][title] ||= { title, time: datetime(), url, store };
    const notify_game = { title, url, status: `failed - link ${store}` };
    notify_games.push(notify_game); // status is updated below
    if (await page.locator('div:has-text("Link game account")').count()) {
      console.error('  Account linking is required to claim this offer!');
    } else {
      // print code if there is one
      const redeem = {
        // 'origin': 'https://www.origin.com/redeem', // TODO still needed or now only via account linking?
        'gog.com': 'https://www.gog.com/redeem',
        'microsoft games': 'https://redeem.microsoft.com',
        'legacy games': 'https://www.legacygames.com/primedeal',
      };
      if (store in redeem) { // did not work for linked origin: && !await page.locator('div:has-text("Successfully Claimed")').count()
        const code = await page.inputValue('input[type="text"]');
        console.log('  Code to redeem game:', code);
        if (store == 'legacy games') { // may be different URL like https://legacygames.com/primeday/puzzleoftheyear/
          redeem[store] = await (await page.$('li:has-text("Click here") a')).getAttribute('href');
        }
        console.log('  URL to redeem game:', redeem[store]);
        db.data[user][title].code = code;
        let redeem_action = 'redeem';
        if (cfg.pg_redeem) { // try to redeem keys on external stores
          console.log(`  Trying to redeem ${code} on ${store} (need to be logged in)!`);
          const page2 = await context.newPage();
          await page2.goto(redeem[store], { waitUntil: 'domcontentloaded' });
          if (store == 'gog.com') {
            // await page.goto(`https://redeem.gog.com/v1/bonusCodes/${code}`); // {"reason":"Invalid or no captcha"}
            await page2.fill('#codeInput', code);
            const r = page2.waitForResponse(r => r.url().startsWith('https://redeem.gog.com/'));
            await page2.click('[type="submit"]');
            // console.log(await page2.locator('.warning-message').innerText());
            const rt = await (await r).text();
            console.debug(`  Response: ${rt}`);
            // {"reason":"Invalid or no captcha"}
            // {"reason":"code_used"}
            // {"reason":"code_not_found"}
            const reason = JSON.parse(rt).reason;
            if (reason.includes('captcha')) {
              redeem_action = 'redeem (got captcha)';
              console.error('  Got captcha; could not redeem!');
            } else if (reason == 'code_used') {
              redeem_action = 'already redeemed';
              console.log('  Code was already used!');
            } else if (reason == 'code_not_found') {
              redeem_action = 'redeem (not found)';
              console.error('  Code was not found!');
            } else { // TODO not logged in? need valid unused code to test.
              redeem_action = 'redeemed?';
              console.log('  Redeemed successfully? Please report your Response from above (if it is new) in https://github.com/vogler/free-games-claimer/issues/5');
            }
          } else if (store == 'microsoft games') {
            console.error(`  Redeem on ${store} not yet implemented!`);
            if (page2.url().startsWith('https://login.')) {
              console.error('  Not logged in! Use the browser to login manually.');
              redeem_action = 'redeem (login)';
            } else {
              const r = page2.waitForResponse(r => r.url().startsWith('https://purchase.mp.microsoft.com/'));
              await page2.fill('[name=tokenString]', code);
              // console.log(await page2.locator('.redeem_code_error').innerText());
              const rt = await (await r).text();
              console.debug(`  Response: ${rt}`);
              // {"code":"NotFound","data":[],"details":[],"innererror":{"code":"TokenNotFound",...
              const reason = JSON.parse(rt).code;
              if (reason == 'NotFound') {
                redeem_action = 'redeem (not found)';
                console.error('  Code was not found!');
              } else { // TODO find out other responses
                await page2.click('#nextButton');
                redeem_action = 'redeemed?';
                console.log('  Redeemed successfully? Please report your Response from above (if it is new) in https://github.com/vogler/free-games-claimer/issues/5');
              }
            }
          } else if (store == 'legacy games') {
            console.error(`  Redeem on ${store} not yet implemented!`);
          }
          await page2.pause();
          await page2.close();
        }
        notify_game.status = `<a href="${redeem[store]}">${redeem_action}</a> ${code} on ${store}`;
      } else {
        notify_game.status = `claimed on ${store}`;
      }
      // save screenshot of potential code just in case
      const p = path.resolve(cfg.dir.screenshots, 'prime-gaming', 'external', `${filenamify(title)}.png`);
      await page.screenshot({ path: p, fullPage: true });
      // console.info('  Saved a screenshot of page to', p);
    }
    // await page.pause();
    await page.goto(URL_CLAIM, { waitUntil: 'domcontentloaded' });
    await page.click('button[data-type="Game"]');
  } while (n);
  const p = path.resolve(cfg.dir.screenshots, 'prime-gaming', `${filenamify(datetime())}.png`);
  // await page.screenshot({ path: p, fullPage: true });
  await page.locator(games_sel).screenshot({ path: p });
} catch (error) {
  console.error(error); // .toString()?
  process.exitCode ||= 1;
  if (error.message && process.exitCode != 130)
    notify(`prime-gaming failed: ${error.message.split('\n')[0]}`);
} finally {
  await db.write(); // write out json db
  if (notify_games.length) { // list should only include claimed games
    notify(`prime-gaming:<br>${html_game_list(notify_games)}`);
  }
}
await context.close();
