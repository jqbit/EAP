# CSV Sum

**Task:** "Write Python code that reads sales.csv and sums the 'amount' column."

Verbatim model output from an upstream benchmark run (Claude Haiku 4.5, temperature 1; provenance: `../../../docs/legal/ATTRIBUTION.md`). The with-skill arm ran the ladder rule that EAP-Lean adapts. EAP has not re-measured; reproduce yourself with [`../bench/`](../bench/).

## Without EAP-Lean, 20 lines of code

# Python code to read sales.csv and sum the 'amount' column

```python
import pandas as pd

# Read the CSV file
df = pd.read_csv('sales.csv')

# Sum the 'amount' column
total_amount = df['amount'].sum()

# Print the result
print(f"Total amount: ${total_amount:,.2f}")
```

## Alternative methods:

**Using CSV module (without pandas):**
```python
import csv

total_amount = 0

with open('sales.csv', 'r') as file:
    reader = csv.DictReader(file)
    for row in reader:
        total_amount += float(row['amount'])

print(f"Total amount: ${total_amount:,.2f}")
```

**Using pandas with error handling:**
```python
import pandas as pd

try:
    df = pd.read_csv('sales.csv')
    total_amount = df['amount'].sum()
    print(f"Total amount: ${total_amount:,.2f}")
except FileNotFoundError:
    print("Error: sales.csv not found")
except KeyError:
    print("Error: 'amount' column not found")
```

**The pandas method is recommended** because it's:
- More concise and readable
- Handles data types automatically
- Provides built-in error handling
- Efficient for large files

## With EAP-Lean, 3 lines of code

```python
import csv

total = sum(float(row['amount']) for row in csv.DictReader(open('sales.csv')))
print(total)
```

Skipped: pandas, error handling, file closing, add when the CSV is large, malformed, or you need more analysis.

**20 → 3 lines of code**, same model, same prompt.
