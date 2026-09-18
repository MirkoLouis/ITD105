# ITD105 Case Study: Philippine Tourist Arrivals Forecasting

## Summary of the Activity
This project is an end-to-end machine learning pipeline built as a multi-page **Streamlit** web application. It processes historical Philippine tourist arrival data alongside climate and hazard predictors. The pipeline encompasses data cleaning, feature selection (using Spearman correlation and Variance Inflation Factor), leakage-safe sequence windowing, training and tuning an **LSTM (Long Short-Term Memory)** neural network, evaluating performance against baseline models, and explaining the model's behavior using **SHAP** (Explainable AI). 

## What the App Wants to Find Out
The primary goal of this application is to **forecast the total number of monthly tourist arrivals to the Philippines** using historical data and environmental predictors (like temperature, rainfall, typhoons, and air quality). 

Beyond just providing a prediction, the app aims to answer *why* the model makes its decisions. By using SHAP, the application identifies which environmental features are the strongest drivers of tourist arrivals and how specific factors (e.g., a typhoon or heavy rainfall) positively or negatively impact the forecast for a given month.

## Screenshots

*to be added*

## Changes from the Provided Source Code & Why

While following the provided HTML instructions, a few necessary adjustments were made to the source code to handle inconsistencies in the real-world dataset and prevent application crashes:

1. **`pages/1_Dataset.py`**
   * **Change**: Added `skiprows=2` to the `pd.read_csv()` function.
   * **Why**: The raw CSV file contained two junk title/header rows before the actual column names. Without skipping these, pandas would fail to parse the columns and data types correctly.

2. **`pages/2_Clean.py`**
   * **Change**: Added logic to drop rows where the `arrivals` target is `NaN` (3 rows) and used `.ffill()` to forward-fill the remaining missing predictor values (like temperature).
   * **Why**: The instructions assumed perfectly clean data, but `scipy.stats.spearmanr` strictly requires inputs without missing values—otherwise, it returns `NaN` for all correlations, causing the feature selection page to fail. Furthermore, you cannot train an LSTM on target values that don't exist.

3. **`pages/3_Features.py`**
   * **Change**: Added an `if not kept:` safeguard to halt execution if no features pass the Spearman filter, and updated the iterative VIF loop condition to `while X.shape[1] > 1:`.
   * **Why**: Variance Inflation Factor (VIF) measures multicollinearity between *multiple* features. If the loop happens to drop columns until only 1 feature remains, the VIF calculation is mathematically undefined and throws a crash.
