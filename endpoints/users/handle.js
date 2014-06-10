var helper = require ("panas").helper;
var handle;


module.exports = User;

/**
 * The User handlers
 */
function User (options) {
  var model = require ("./model")(options);
  handle = helper.Handle (model);
  if (!(this instanceof User)) return new User (options);
}

User.prototype.find = function * (){
  yield handle.get (this, "find", {});
}

User.prototype.findOne = function * (){
  yield handle.get (this, "findOne", {});
}

User.prototype.update = function * (){
  yield handle.put (this, "update", {});
}

User.prototype.remove = function * (){
  yield handle.get (this, "remove", {});
}

User.prototype.create = function * (){
  yield handle.post (this, "create", {});
}

User.prototype.authenticate = function * (){
  yield handle.post (this, "authenticate", {});
}

User.prototype.activate = function * (){
    yield handle.get (this, "activate", {});
}

