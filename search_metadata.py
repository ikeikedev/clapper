import os

for root, dirs, files in os.walk('.'):
    for f in files:
        if f.endswith('.tsx') or f.endswith('.ts'):
            path = os.path.join(root, f)
            try:
                with open(path, 'r', encoding='utf-8') as file:
                    content = file.read()
                    if 'metadata' in content:
                        print(f"Found 'metadata' in {path}")
            except Exception as e:
                pass
