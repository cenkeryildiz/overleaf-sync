// SPDX-License-Identifier: AGPL-3.0-only
// CE+ authors: Overleaf, yu-i-i and davrot; modified by Cenker YILDIZ, 2026-11-15.
import logger from '@overleaf/logger'
import passport from 'passport'
import Settings from '@overleaf/settings'
import AuthenticationController from '../../../../../app/src/Features/Authentication/AuthenticationController.mjs'
import UserController from '../../../../../app/src/Features/User/UserController.mjs'
import ThirdPartyIdentityManager from '../../../../../app/src/Features/User/ThirdPartyIdentityManager.mjs'
import OIDCAuthenticationManager from './OIDCAuthenticationManager.mjs'

const OIDCAuthenticationController = {
  passportLogin(req, res, next) {
    req.session.intent = req.query.intent
    passport.authenticate('openidconnect')(req, res, next)
  },
  passportLoginCallback(req, res, next) {
    passport.authenticate(
      'openidconnect',
      { keepSessionInfo: true },
      async function (err, user, info) {
        if (err) {
          return next(err)
        }
        delete req.session.idToken
        if(req.session.intent === 'link') {
          delete req.session.intent
          if (user) return res.redirect('/user/settings')
	}
        if (user) {
          user.externalAuth = 'oidc'
          // `user` is either a user object or false
          AuthenticationController.setAuditInfo(req, {
            method: 'OIDC login',
          })
          try {
            await AuthenticationController.promises.finishLogin(user, req, res)
          } catch (err) {
            return next(err)
          }
        } else {
          if (info.redir != null) {
            await UserController.doLogout(req)
            return res.redirect(info.redir)
          } else {
            res.status(info.status || 401)
            delete info.status
            const body = { message: info }
            return res.json(body)
          }
        }
      }
    )(req, res, next)
  },
  // Passport selects the callback form by arity; retain all ten parameters.
  async doPassportLogin(req, issuer, uiProfile, idProfile, context, idToken, accessToken, refreshToken, params, done) {
    if (uiProfile && uiProfile.id !== idProfile?.id) {
      return done(Object.assign(new Error('OIDC userinfo subject does not match the ID token'), { status: 403 }))
    }
    const profile = uiProfile ?? idProfile //id Profile if _skipUserProfile is true
    let user, info
    try {
      if(req.session.intent === 'link') {
        ;({ user, info } = await OIDCAuthenticationController._doLink(
          req,
          profile
        ))
      } else {
        ;({ user, info } = await OIDCAuthenticationController._doLogin(
          req,
          profile
        ))
      }
    } catch (error) {
      return done(error)
    }
    return done(null, user, info)
  },
  async _doLogin(req, profile) {
    const { fromKnownDevice } = AuthenticationController.getAuditInfo(req)
    const auditLog = {
      ipAddress: req.ip,
      info: { method: 'OIDC login', fromKnownDevice },
    }

    let user
    try {
      user = await OIDCAuthenticationManager.promises.findOrCreateUser(profile, auditLog)
    } catch (error) {
      logger.debug('OIDC login failed')
      return {
        user: false,
        info: {
          type: 'error',
          text: error.message,
          status: error.status || 500,
        },
      }
    }
    if (user) {
      return { user, info: undefined }
    } else { // user account is not created
      logger.debug({ email : profile.emails[0].value }, 'OIDC JIT account creation is not allowed for this email')
      return {
        user: false,
        info: {
          redir: '/register',
          status: 401,
        },
      }
    }
  },
  async _doLink(req, profile) {
    const { user: { _id: userId }, ip } = req
    try {
      const auditLog = {
        ipAddress: ip,
        initiatorId: userId,
      }
      await OIDCAuthenticationManager.promises.linkAccount(userId, profile, auditLog)
    } catch (error) {
      logger.error('OIDC account linking failed')
      return {
        user: false,
        info: {
          type: 'error',
          text: error.message,
          status: error.status || 409,
        },
      }
    }
    return { user: true, info: undefined }
  },
  async unlinkAccount(req, res, next) {
    try {
      const { user: { _id: userId }, body: { providerId }, ip } = req
      const auditLog = {
        ipAddress: ip,
        initiatorId: userId,
      }
      await ThirdPartyIdentityManager.promises.unlink(userId, providerId, auditLog)
      return res.status(204).end()
    } catch (error) {
      logger.error('Unexpected error in uninkAccount')
      return next({ stack: error.stack, info: {userId: req.user?._id} })
    }
  },
  async passportLogout(req, res, next) {
    await UserController.doLogout(req)
    res.redirect(Settings.siteUrl)
  },
  passportLogoutCallback(req, res, next) {
    const redirectUri = Settings.siteUrl
    res.redirect(redirectUri)
  },
}
export default OIDCAuthenticationController
