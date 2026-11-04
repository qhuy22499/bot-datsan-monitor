"""Vietnamese date presentation only; storage keys remain ISO calendar dates."""
from .shared.domain import parse_date

WEEKDAYS = ('T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN')


def display_date(iso_date):
    day = parse_date(iso_date)
    return f'{WEEKDAYS[day.weekday()]} {day:%d/%m/%Y}'
