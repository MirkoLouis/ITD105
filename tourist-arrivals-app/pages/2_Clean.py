# pages/2_Clean.py
import streamlit as st

st.title("2. Clean the data")

if "raw_df" not in st.session_state:
    st.warning("Run the Dataset page first.")
    st.stop()

if st.button("Run cleaning"):
    df = st.session_state.raw_df.copy()

    duplicates_removed = int(df.duplicated(subset="date").sum())
    df = df.drop_duplicates(subset="date", keep="first")

    missing = df.isna().sum()
    missing = missing[missing > 0]

    target_nulls = int(df["arrivals"].isna().sum())
    df = df.dropna(subset=["arrivals"])
    df = df.ffill()

    # Manual correction for outlier row in Feb 2001 (~34.2 million)
    df.loc[df["date"] == "2001-02-01", "arrivals"] = 190000

    q1, q3 = df["arrivals"].quantile([0.25, 0.75])
    iqr = q3 - q1
    lower, upper = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    flagged = df[(df["arrivals"] < lower) | (df["arrivals"] > upper)]

    print(f"\n[2_Clean] Running cleaning...")
    print(f"[2_Clean] Duplicates removed: {duplicates_removed}")
    print(f"[2_Clean] Target NaN rows dropped: {target_nulls}")
    print(f"[2_Clean] Max arrivals after manual fix: {df['arrivals'].max():,.0f}")
    print(f"[2_Clean] Flagged outliers count: {len(flagged)}")

    st.session_state.clean_df = df  # used by every later page
    st.session_state.clean_report = {
        "duplicates_removed": duplicates_removed,
        "target_nulls": target_nulls,
        "missing": missing,
        "flagged": flagged[["date", "arrivals"]],
    }

# Displayed outside the button block, so the result is still here if you
# leave this page and come back.
if "clean_report" in st.session_state:
    report = st.session_state.clean_report
    st.write(f"Duplicates removed: {report['duplicates_removed']}")
    st.write(f"Rows dropped (arrivals = NaN): {report['target_nulls']}")
    st.write("Missing values by column (before fill):")
    st.dataframe(report["missing"])
    st.write("Flagged outliers:")
    st.dataframe(report["flagged"])
else:
    st.info('Click "Run cleaning" to process the dataset loaded on the Dataset page.')
