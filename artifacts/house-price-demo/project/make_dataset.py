"""Generate a deterministic synthetic house-price dataset (no download needed)."""
import csv
import numpy as np

rng = np.random.default_rng(7)
n = 12000
sqft = rng.gamma(9, 210, n).clip(450, 6000)
bedrooms = np.clip(np.round(sqft / 650 + rng.normal(0, 0.7, n)), 1, 7)
bathrooms = np.clip(np.round(bedrooms * 0.6 + rng.normal(0.4, 0.5, n)), 1, 5)
age = rng.integers(0, 100, n)
distance_km = rng.gamma(2.2, 5.5, n).clip(0.3, 60)
school_rating = np.clip(np.round(rng.normal(6, 2, n)), 1, 10)
lot_sqft = (sqft * rng.uniform(1.2, 5, n) * (1 + distance_km / 20)).round()
garage = (rng.random(n) < 0.35 + distance_km / 80).astype(int)

location = 1.6 * np.exp(-distance_km / 12) + 0.45
depreciation = 1 - 0.0055 * age + 0.000032 * age**2  # older homes regain some value as "character"
price = (
    40000
    + 175 * sqft * location * depreciation
    + 9000 * (school_rating - 5) * location
    + 6500 * bathrooms
    + 1.8 * lot_sqft
    + 14000 * garage
)
price *= rng.lognormal(0, 0.11, n)

columns = dict(sqft=sqft.round(), bedrooms=bedrooms, bathrooms=bathrooms, age=age,
               distance_km=distance_km.round(2), school_rating=school_rating,
               lot_sqft=lot_sqft, garage=garage, price=price.round(-2))
with open('data/houses.csv', 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(columns)
    w.writerows(zip(*[[int(v) if float(v).is_integer() else float(v) for v in c] for c in columns.values()]))
print(f'Wrote {n} rows to data/houses.csv; median price ${np.median(price):,.0f}')
