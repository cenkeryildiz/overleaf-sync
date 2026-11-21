# SPDX-License-Identifier: AGPL-3.0-only
# Optional R analysis adapter (ANALYSIS-01): base `stats` only plus jsonlite for I/O; installs nothing.
# Rscript --vanilla analysis.R < request.json > result.json. Columns are renamed before modelling, so no
# user-supplied string is ever parsed as an R formula. Result fields match analysis.py.
suppressPackageStartupMessages(library(jsonlite))
emit <- function(x) { cat(toJSON(x, auto_unbox = TRUE, na = "null", digits = NA, null = "null")); quit(save = "no", status = 0) }
fail <- function(status, reason) emit(list(status = status, reason = reason))
vec <- function(x) I(unname(as.numeric(x)))
req <- tryCatch(fromJSON(paste(readLines(file("stdin"), warn = FALSE), collapse = "\n"), simplifyVector = TRUE), error = function(e) NULL)
if (!is.list(req)) fail("unsupported", "Malformed request")
MAX_ROWS <- 200000L

df <- tryCatch({
  if (!is.null(req$csv)) read.csv(as.character(req$csv), check.names = FALSE, nrows = MAX_ROWS + 1L)
  else if (is.list(req$data)) as.data.frame(req$data, check.names = FALSE, stringsAsFactors = FALSE)
  else NULL
}, error = function(e) NULL)
if (is.null(df)) fail("unsupported", "Provide data or csv")
if (nrow(df) > MAX_ROWS) fail("unsupported", "Data exceeds 200000 rows")
need <- function(names, numeric = TRUE) {
  names <- as.character(names)
  miss <- setdiff(names, names(df)); if (length(miss)) fail("unsupported", paste0("Unknown column '", miss[1], "'"))
  if (numeric) for (n in names) if (!is.numeric(df[[n]])) fail("unsupported", paste0("Column '", n, "' is not numeric"))
}
coef_table <- function(m, terms, n0, nobs, method, V = NULL, dfi = NULL) {
  k <- seq_along(terms); sm <- summary(m)
  if (is.null(V)) { ci <- confint(m); se <- sm$coefficients[k, 2]; tt <- sm$coefficients[k, 3]; p <- sm$coefficients[k, 4]; lo <- ci[k, 1]; hi <- ci[k, 2] }
  else { b <- coef(m)[k]; se <- sqrt(diag(V))[k]; tt <- b / se; p <- 2 * pt(abs(tt), dfi, lower.tail = FALSE); q <- qt(0.975, dfi); lo <- b - q * se; hi <- b + q * se }
  r <- list(status = "computed", method = method, nobs = nobs, dropped_rows = n0 - nobs, missing_policy = "listwise deletion", df_resid = m$df.residual,
            r_squared = sm$r.squared, terms = I(terms), estimate = vec(coef(m)[k]), std_error = vec(se), t = vec(tt), p = vec(p), ci_low = vec(lo), ci_high = vec(hi),
            versions = list(R = R.version.string))
  if (!is.null(dfi)) r$df_inference <- dfi
  r
}
# id/cluster are explicit columns (any type); they must be distinct from the outcome and regressors.
design <- function(y, xs, id = NULL, cluster = NULL) {
  xs <- as.character(xs); extra <- unique(c(id, cluster)); extra <- extra[!is.na(extra) & extra != ""]
  need(c(y, xs, extra), numeric = FALSE); need(c(y, xs))
  if (!length(xs) || length(xs) > 30 || y %in% xs || anyDuplicated(xs)) fail("unsupported", "Choose one outcome and 1 to 30 distinct regressors")
  if (any(extra %in% c(y, xs))) fail("unsupported", "The entity/cluster column must differ from the outcome and regressors")
  d <- df[c(y, xs, extra)]; n0 <- nrow(d); d <- d[complete.cases(d), , drop = FALSE]
  if (nrow(d) <= length(xs) + 1L + (if (length(id)) length(unique(d[[id]])) else 0L)) fail("inconclusive", "Too few complete rows for this model")
  list(d = d, n0 = n0, xs = xs, cluster = if (length(cluster)) as.character(d[[cluster]]) else NULL)
}
fit_lm <- function(d, xs, id = NULL) {
  m <- data.frame(y = d[[1]], d[xs]); names(m) <- c("y", paste0("v", seq_along(xs)))
  if (length(id)) m$g <- factor(d[[id]])
  fit <- lm(y ~ ., data = m)
  if (any(is.na(coef(fit)))) fail("inconclusive", "Regressors are perfectly collinear")
  fit
}
# CR1 cluster-robust covariance (Stata's small-sample factor G/(G-1) * (N-1)/(N-K)), base R only.
cr1 <- function(fit, cl) {
  X <- model.matrix(fit); e <- residuals(fit); n <- nrow(X); K <- ncol(X); G <- length(unique(cl))
  if (G < 2L) fail("inconclusive", "At least two clusters are needed")
  bread <- solve(crossprod(X)); S <- rowsum(X * e, cl)
  list(V = G / (G - 1) * (n - 1) / (n - K) * bread %*% crossprod(S) %*% bread, G = G)
}
# Newey-West (Bartlett) HAC covariance for rows in time order; no small-sample correction.
newey_west <- function(fit, L) {
  X <- model.matrix(fit); u <- X * residuals(fit); n <- nrow(X); bread <- solve(crossprod(X)); S <- crossprod(u)
  for (j in seq_len(L)) { Gj <- crossprod(u[(j + 1L):n, , drop = FALSE], u[1L:(n - j), , drop = FALSE]); S <- S + (1 - j / (L + 1)) * (Gj + t(Gj)) }
  bread %*% S %*% bread
}
cluster_name <- function() { cl <- req$cluster; if (is.null(cl)) NULL else { if (!is.character(cl) || length(cl) != 1L) fail("unsupported", "cluster must be one column name"); cl } }
op <- req$op
if (identical(op, "ols")) {
  cl <- cluster_name(); L <- req$hac_lags
  if (!is.null(cl) && !is.null(L)) fail("unsupported", "Choose cluster or hac_lags, not both")
  x <- design(as.character(req$y), req$x, cluster = cl); fit <- fit_lm(x$d, x$xs); terms <- c("(Intercept)", x$xs); n <- nrow(x$d)
  if (!is.null(cl)) {
    r <- cr1(fit, x$cluster)
    emit(coef_table(fit, terms, x$n0, n, sprintf("OLS (lm), CR1 cluster-robust standard errors by '%s' (%d clusters; t with G-1 df)", cl, r$G), r$V, r$G - 1L))
  } else if (!is.null(L)) {
    if (!is.numeric(L) || length(L) != 1L || L != round(L) || L < 0 || L > min(50, n - 2L)) fail("unsupported", "hac_lags must be a whole number from 0 to min(50, n-2)")
    if (x$n0 != n) fail("inconclusive", "HAC needs a complete, regularly spaced series; rows with missing values were found")
    emit(coef_table(fit, terms, x$n0, n, sprintf("OLS (lm), Newey-West HAC standard errors, %d lags, rows taken in the given time order (t with N-K df)", as.integer(L)), newey_west(fit, as.integer(L)), fit$df.residual))
  } else emit(coef_table(fit, terms, x$n0, n, "OLS (lm), classical standard errors"))
} else if (identical(op, "panel_fe")) {
  id <- as.character(req$id); cl <- cluster_name()
  x <- design(as.character(req$y), req$x, id = id, cluster = cl); fit <- fit_lm(x$d, x$xs, id = id); terms <- c("(Intercept)", x$xs)
  if (is.null(cl)) r <- coef_table(fit, terms, x$n0, nrow(x$d), "Entity fixed effects via lm with entity dummies; classical standard errors, NOT clustered")
  else { c1 <- cr1(fit, x$cluster); r <- coef_table(fit, terms, x$n0, nrow(x$d), sprintf("Entity fixed effects via lm with entity dummies; CR1 standard errors clustered by '%s' (%d clusters; t with G-1 df; entity dummies counted in K, unlike Stata xtreg, fe)", cl, c1$G), c1$V, c1$G - 1L); r$clusters <- c1$G }
  r$entities <- length(unique(x$d[[id]])); r$note <- "Intercept is the reference entity's level"
  emit(r)
} else if (identical(op, "ttest")) {
  col <- as.character(req$x); need(col); cl <- if (is.null(req$conf_level)) 0.95 else as.numeric(req$conf_level)
  if (!is.finite(cl) || cl <= 0 || cl >= 1) fail("unsupported", "conf_level must be between 0 and 1")
  v <- df[[col]]; n0 <- length(v)
  if (!is.null(req$group)) {
    g <- as.character(req$group); need(g, numeric = FALSE); ok <- !is.na(v) & !is.na(df[[g]]); lv <- sort(unique(df[[g]][ok]))
    if (length(lv) != 2L) fail("unsupported", "Group column must have exactly two groups")
    a <- v[ok & df[[g]] == lv[1]]; b <- v[ok & df[[g]] == lv[2]]
    if (length(a) < 2L || length(b) < 2L) fail("inconclusive", "Each group needs at least two values")
    t <- t.test(a, b, conf.level = cl); method <- "Welch two-sample t-test (difference of group means: first minus second group)"
    emit(list(status = "computed", method = method, groups = I(as.character(lv)), n = I(c(length(a), length(b))), estimate = vec(t$estimate), difference = unname(t$estimate[1] - t$estimate[2]),
              t = unname(t$statistic), df = unname(t$parameter), p = t$p.value, conf_level = cl, ci_low = t$conf.int[1], ci_high = t$conf.int[2], dropped_rows = n0 - length(a) - length(b)))
  }
  mu <- if (is.null(req$mu)) 0 else as.numeric(req$mu); v <- v[!is.na(v)]
  if (length(v) < 2L) fail("inconclusive", "At least two values are needed")
  t <- t.test(v, mu = mu, conf.level = cl)
  emit(list(status = "computed", method = "One-sample t-test", n = length(v), estimate = unname(t$estimate), mu = mu, t = unname(t$statistic), df = unname(t$parameter),
            p = t$p.value, conf_level = cl, ci_low = t$conf.int[1], ci_high = t$conf.int[2], dropped_rows = n0 - length(v)))
} else if (identical(op, "arima")) {
  col <- as.character(req$x); need(col); o <- as.integer(unlist(req$order))
  if (length(o) != 3L || any(is.na(o)) || any(o < 0L) || any(o > 5L)) fail("unsupported", "order must be three integers from 0 to 5")
  v <- df[[col]]; if (anyNA(v)) fail("inconclusive", "Missing values in a time series are not interpolated; clean them first")
  if (length(v) < 3L * (sum(o) + 1L) + 5L) fail("inconclusive", "Series too short for this order")
  m <- tryCatch(suppressWarnings(arima(v, order = o, method = "CSS-ML")), error = function(e) NULL)
  if (is.null(m)) fail("inconclusive", "The model could not be estimated (non-stationary or failed optimisation)")
  se <- sqrt(diag(m$var.coef)); lag <- min(10L, length(v) %/% 5L); lb <- Box.test(residuals(m), lag = max(lag, sum(o[c(1, 3)]) + 1L), type = "Ljung-Box", fitdf = sum(o[c(1, 3)]))
  emit(list(status = "computed", method = sprintf("ARIMA(%d,%d,%d) by CSS-ML (stats::arima)", o[1], o[2], o[3]), nobs = length(v), terms = I(names(coef(m))), estimate = vec(coef(m)), std_error = vec(se),
            sigma2 = m$sigma2, aic = m$aic, ljung_box_p = lb$p.value, ljung_box_lag = unname(lb$parameter), versions = list(R = R.version.string)))
} else fail("unsupported", "Unknown operation")
