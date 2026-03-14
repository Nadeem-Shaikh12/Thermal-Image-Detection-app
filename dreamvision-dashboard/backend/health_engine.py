import numpy as np

def calculate_health_score(current_temp, threshold, history=None):
    """
    Calculates an Asset Health Score (AHS) from 0 to 100.
    
    Factors:
    - Temperature vs Threshold (50%)
    - Rate of Change / Trend (25%)
    - Historical Stability (25%)
    """
    if threshold <= 0:
        return 100.0

    # 1. Proximity Score (0 to 50)
    # 100% health at <= 30C, drops to 0% at threshold
    # Linear drop from 1.0 to 0.0
    safe_temp = 30.0
    if current_temp <= safe_temp:
        proximity_factor = 1.0
    elif current_temp >= threshold:
        proximity_factor = 0.0
    else:
        proximity_factor = 1.0 - (current_temp - safe_temp) / (threshold - safe_temp)
    
    score_proximity = proximity_factor * 50.0

    # 2. Trend Score (0 to 25)
    # Penalizes rising temperatures
    score_trend = 25.0
    if history and len(history) >= 3:
        # Simple slope of last 3 points
        y = history[-3:]
        x = np.array([0, 1, 2])
        slope = np.polyfit(x, y, 1)[0]
        
        # If slope > 2C/update, starts penalizing
        if slope > 0:
            trend_factor = max(0.0, 1.0 - (slope / 5.0)) # 0 score at 5C/update spike
            score_trend = trend_factor * 25.0

    # 3. Stability Score (0 to 25)
    # Penalizes high variance in recent data
    score_stability = 25.0
    if history and len(history) >= 5:
        variance = np.var(history[-5:])
        # Variance > 10 (std dev > 3.1) starts penalizing
        stability_factor = max(0.0, 1.0 - (variance / 50.0)) # 0 score at variance of 50
        score_stability = stability_factor * 25.0

    total_score = score_proximity + score_trend + score_stability
    return round(float(np.clip(total_score, 0, 100)), 1)
