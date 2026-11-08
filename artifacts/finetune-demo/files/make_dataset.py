"""Golden datasets for Lumen support-ticket triage (synthetic, deterministic).

Each ticket is assembled from a problem, a product mention, optional severity and
escalation cues, and greeting/sign-off noise. Labels come from Lumen's triage
policy below, so every example has a known-correct answer:

  priority     P1 = outage, data loss or a whole team blocked
               P2 = one person blocked or a payment failing
               P3 = everything else (questions, feature requests)
  needs_human  true when the customer asks for a refund, threatens to cancel,
               or mentions lawyers / a security incident
  product      what the ticket is about: web_app, mobile_app, api, hardware

The eval set uses different sentence templates, product names, and cue wording
than the training set, so it measures generalization, not memorization.

  python make_dataset.py             ->  data/train.jsonl (400), data/eval.jsonl (40)
  python make_dataset.py --round 2   ->  data/train.jsonl (600, broader phrasing), same eval
"""
import json
import pathlib
import random
import sys

SYSTEM = (
    "You are Lumen's support triage assistant. Read the ticket and reply with only a JSON object "
    "with keys: category (billing, bug, account_access, feature_request, shipping), "
    "priority (P1, P2, P3), product (web_app, mobile_app, api, hardware), needs_human (true or false)."
)

POOLS = {
    'train': {
        'products': {
            'web_app': ['web dashboard', 'website', 'browser app'],
            'mobile_app': ['Android app', 'mobile app', 'iOS app'],
            'api': ['API', 'webhooks', 'Python SDK'],
            'hardware': ['sensor hub', 'Lumen hub device', 'door sensor'],
        },
        'problems': {
            'billing': ['I was charged twice for my subscription on the {p} this month.',
                        'My invoice for the {p} shows the wrong plan.',
                        'You billed me again after I cancelled the {p}.'],
            'payment': ['The card payment keeps failing when I upgrade in the {p}.'],
            'bug': ['The {p} crashes every time I open reports.',
                    'Exports from the {p} come out completely empty.',
                    'After the last update the {p} only shows a blank screen.'],
            'account_access': ["I can't log in to the {p} anymore.",
                               'Password reset emails for the {p} never arrive.',
                               'The {p} keeps rejecting my two-factor codes.'],
            'feature_request': ['It would be great if the {p} had a dark mode.',
                                'Could you add CSV export to the {p}?',
                                'Please let the {p} support single sign-on.'],
            'shipping': ['My {p} order still has not arrived.',
                         'The {p} arrived with a cracked case.',
                         'Tracking for my {p} has not updated in a week.'],
        },
        'p1': ['Our whole team is affected.', 'This is a production outage for us.',
               'We are losing customer data because of this.'],
        'p2': ["I'm completely blocked on my work.", 'This is stopping me from getting anything done today.'],
        'p3': ['No rush on this.', 'Just wanted to let you know.', ''],
        'human': ['I want a full refund.', 'If this is not fixed we will cancel our contract.',
                  'Our lawyers are asking about this.'],
        'greetings': ['Hi,', 'Hello team,', 'Hey there,', ''],
        'signoffs': ['Thanks, {n}', 'Regards, {n}', '- {n}', ''],
        'names': ['Priya', 'Marco', 'Aiko', 'Daniel', 'Fatima', 'Lukas', 'Chen', 'Sara'],
    },
    'eval': {
        'products': {
            'web_app': ['admin console', 'web portal'],
            'mobile_app': ['iPhone app', 'tablet app'],
            'api': ['REST endpoint', 'GraphQL API'],
            'hardware': ['motion sensor', 'smart thermostat'],
        },
        'problems': {
            'billing': ['There are two identical charges from the {p} on my statement.',
                        'The {p} invoice lists a plan we never signed up for.'],
            'payment': ['Checkout in the {p} declines my card every time.'],
            'bug': ['Whenever I filter results the {p} freezes.',
                    'Charts in the {p} show the wrong numbers since Monday.'],
            'account_access': ['The {p} says my account is locked.',
                               'Single sign-on into the {p} loops back to the login page.'],
            'feature_request': ['Any plans to add scheduled reports to the {p}?',
                                'A keyboard shortcut for search in the {p} would help.'],
            'shipping': ['The {p} I ordered was delivered to the wrong address.',
                         'My {p} shipment is two weeks late.'],
        },
        'p1': ['Nobody at our company can work right now.', 'Records are disappearing from our account.'],
        'p2': ['I cannot finish my tasks until this works.'],
        'p3': ['Whenever you get a chance.', ''],
        'human': ['Please refund the charge.', "We're considering switching vendors over this.",
                  'This may be a security breach.'],
        'greetings': ['Good morning,', 'Hi support,', ''],
        'signoffs': ['Cheers, {n}', 'Best, {n}', ''],
        'names': ['Olu', 'Ingrid', 'Rafael', 'Mei'],
    },
}


# Round 2: added after reading round-1 eval failures. The model missed urgency and escalation
# worded differently from training, so we broaden phrasing coverage. These are new paraphrases,
# not copies of eval tickets; the eval set never changes.
ROUND2 = {
    'products': {
        'web_app': ['web app', 'online dashboard', 'customer portal'],
        'mobile_app': ['phone app', 'iPad app'],
        'api': ['REST API', 'API integration'],
        'hardware': ['smart plug', 'temperature sensor', 'security camera'],
    },
    'p1': ['Everyone in our office is stuck.', 'The entire company is down.',
           'Data is vanishing from our workspace.', 'All of our users are affected.'],
    'p2': ["I can't do my job until this is fixed.", 'This blocks me personally.'],
    'human': ['We may switch to a competitor.', 'I think someone hacked our account.',
              'Refund me, please.', 'We will escalate this to our legal team.'],
}


def ticket(rng, pool):
    kind = rng.choice(list(pool['problems']))
    category = 'billing' if kind == 'payment' else kind
    product = 'hardware' if category == 'shipping' else rng.choice(list(pool['products']))
    parts = [rng.choice(pool['greetings']), rng.choice(pool['problems'][kind]).format(p=rng.choice(pool['products'][product]))]
    if category == 'feature_request':
        priority = 'P3'
        parts.append(rng.choice(pool['p3']))
    else:
        priority = rng.choices(['P1', 'P2', 'P3'], weights=[3, 3, 4])[0]
        if kind == 'payment' and priority == 'P3':
            priority = 'P2'  # policy: a failing payment is P2 even without urgent wording
        else:
            parts.append(rng.choice(pool[priority.lower()]))
    needs_human = category != 'feature_request' and rng.random() < 0.35
    if needs_human:
        parts.append(rng.choice(pool['human']))
    parts.append(rng.choice(pool['signoffs']).format(n=rng.choice(pool['names'])))
    text = ' '.join(part for part in parts if part)
    label = {'category': category, 'priority': priority, 'product': product, 'needs_human': needs_human}
    return text, json.dumps(label, separators=(',', ':'))


def build(split, count, seed):
    rng, seen, rows = random.Random(seed), set(), []
    while len(rows) < count:
        text, answer = ticket(rng, POOLS[split])
        if text in seen:
            continue
        seen.add(text)
        rows.append((text, answer))
    return rows


def main():
    round2 = sys.argv[1:] == ['--round', '2']
    if round2:
        pool = POOLS['train']
        for key, extra in ROUND2.items():
            if key == 'products':
                for product, names in extra.items():
                    pool['products'][product] += names
            else:
                pool[key] += extra
    data = pathlib.Path('data')
    data.mkdir(exist_ok=True)
    train, held_out = build('train', 600 if round2 else 400, 7), build('eval', 40, 11)
    assert not {t for t, _ in train} & {t for t, _ in held_out}
    with (data / 'train.jsonl').open('w') as stream:
        for text, answer in train:
            stream.write(json.dumps({'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': text},
                                                  {'role': 'assistant', 'content': answer}]}) + '\n')
    with (data / 'eval.jsonl').open('w') as stream:
        for index, (text, answer) in enumerate(held_out, 1):
            stream.write(json.dumps({'id': f'ticket-{index:02}', 'messages': [{'role': 'system', 'content': SYSTEM},
                                     {'role': 'user', 'content': text}], 'expected': answer}) + '\n')
    print(f'Round {2 if round2 else 1}: wrote {len(train)} training and {len(held_out)} held-out eval tickets to data/')


if __name__ == '__main__':
    main()
