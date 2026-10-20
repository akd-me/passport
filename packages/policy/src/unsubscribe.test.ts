import { describe, expect, it } from 'vitest';
import { parseListUnsubscribe } from './unsubscribe.js';

describe('List-Unsubscribe parsing', () => {
  it('parses folded headers, prefers the first HTTPS target, and recognizes one-click', () => {
    const parsed = parseListUnsubscribe('<http://insecure.example/u>,\r\n <HTTPS://lists.example/u?token=secret>, <https://second.example/u>, <mailto:leave@example.com>', 'other; list-unsubscribe=one-click');
    expect(parsed.https?.href).toBe('https://lists.example/u?token=secret');
    expect(parsed.mailto).toEqual({ address: 'leave@example.com', subject: 'unsubscribe', textBody: 'unsubscribe' });
    expect(parsed.oneClick).toBe(true);
  });

  it('decodes mailto addresses, subjects, and bodies while ignoring other mail headers', () => {
    expect(parseListUnsubscribe('<mailto:leave%2Bnews@example.com?subject=Stop%20mail&body=Please%20stop%0AThanks&cc=ignored@example.com>').mailto).toEqual({
      address: 'leave+news@example.com', subject: 'Stop mail', textBody: 'Please stop\nThanks',
    });
  });

  it('preserves explicitly empty mailto query fields', () => {
    expect(parseListUnsubscribe('<mailto:leave@example.com?subject=&body=>').mailto).toEqual({ address: 'leave@example.com', subject: '', textBody: '' });
  });

  it('skips malformed targets and invalid mailto recipients in favor of later valid targets', () => {
    const parsed = parseListUnsubscribe('<https://>, <mailto:%ZZ@example.com>, <mailto:bad%0D%0Aaddress@example.com>, <mailto:one@example.com,two@example.com>, <mailto:valid@example.com>, <https://valid.example/u>');
    expect(parsed.https?.host).toBe('valid.example');
    expect(parsed.mailto?.address).toBe('valid@example.com');
  });

  it.each([undefined, null, '', '<http://insecure.example/u>', '<ftp://files.example/u>', '<https://user:password@lists.example/u>', 'https://unbracketed.example/u'])('has no supported targets for %s', value => {
    expect(parseListUnsubscribe(value)).toEqual({ https: undefined, mailto: undefined, oneClick: false });
  });

  it.each(['List-Unsubscribe=One-Click-Other', 'OtherList-Unsubscribe=One-Click', 'List-Unsubscribe=No', ''])('does not treat %s as one-click', post => {
    expect(parseListUnsubscribe(undefined, post).oneClick).toBe(false);
  });
});
